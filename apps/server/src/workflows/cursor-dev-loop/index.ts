export const definition = {
  id: "cursor-dev-loop",
  type: "cursor" as const,
  name: "需求点开发循环",
  graph: {
    nodes: [
      { id: "plan", label: "Plan" },
      { id: "develop", label: "开发" },
      { id: "review", label: "Review" },
      { id: "devops", label: "DevOps" },
    ],
    edges: [
      { from: "plan", to: "develop" },
      { from: "develop", to: "review" },
      { from: "review", to: "devops" },
      { from: "review", to: "plan", back: true },
    ],
  },
};
