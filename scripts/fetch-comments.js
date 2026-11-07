const fs = require("node:fs/promises");
const path = require("node:path");

const TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO] = process.env.GITHUB_REPOSITORY.split("/");

if (!TOKEN) {
  throw new Error("Missing GITHUB_TOKEN");
}

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (!response.ok || result.errors) {
    throw new Error(JSON.stringify(result.errors || result));
  }

  return result.data;
}

const commentFields = `
  id
  body
  url
  createdAt
  updatedAt
  author {
    login
    avatarUrl
    url
  }
`;

async function fetchDiscussions() {
  const discussions = [];
  let cursor = null;

  while (true) {
    const data = await graphql(
      `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          discussions(
            first: 100
            after: $cursor
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes {
              id
              number
              title
              url
              createdAt
              updatedAt
              category {
                name
                slug
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      `,
      { owner: OWNER, repo: REPO, cursor }
    );

    const connection = data.repository.discussions;
    discussions.push(...connection.nodes);

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return discussions;
}

async function fetchComments(discussionId) {
  const comments = [];
  let cursor = null;

  // 获取所有顶层评论
  while (true) {
    const data = await graphql(
      `
      query($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on Discussion {
            comments(first: 100, after: $cursor) {
              nodes {
                ${commentFields}
                isAnswer
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
      `,
      { id: discussionId, cursor }
    );

    const connection = data.node.comments;
    comments.push(...connection.nodes);

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  // 获取每条顶层评论下的全部回复
  const result = [];

  for (const comment of comments) {
    result.push({
      ...comment,
      parentId: null,
    });

    let replyCursor = null;

    while (true) {
      const data = await graphql(
        `
        query($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on DiscussionComment {
              replies(first: 100, after: $cursor) {
                nodes {
                  ${commentFields}
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
        `,
        { id: comment.id, cursor: replyCursor }
      );

      const connection = data.node.replies;

      for (const reply of connection.nodes) {
        result.push({
          ...reply,
          parentId: comment.id,
          isAnswer: false,
        });
      }

      if (!connection.pageInfo.hasNextPage) break;
      replyCursor = connection.pageInfo.endCursor;
    }
  }

  return result;
}

async function main() {
  console.log("Fetching discussions...");

  const discussions = await fetchDiscussions();
  const allComments = [];

  for (const discussion of discussions) {
    console.log(`Fetching #${discussion.number}: ${discussion.title}`);

    const comments = await fetchComments(discussion.id);

    for (const comment of comments) {
      allComments.push({
        ...comment,
        discussion: {
          id: discussion.id,
          number: discussion.number,
          title: discussion.title,
          url: discussion.url,
          category: discussion.category,
        },
      });
    }
  }

  allComments.sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const output = {
    generatedAt: new Date().toISOString(),
    discussionCount: discussions.length,
    commentCount: allComments.length,
    comments: allComments,
  };

  const outputPath = path.join(process.cwd(), "comments.json");

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2) + "\n",
    "utf8"
  );

  console.log(`Generated ${allComments.length} comments.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
