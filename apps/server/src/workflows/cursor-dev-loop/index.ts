export const definition = {
  id: "cursor-dev-loop",
  type: "cursor" as const,
  name: "需求点开发循环",
  graph: {
    nodes: [
      { id: "develop", label: "开发" },
      { id: "arch", label: "架构审核" },
      { id: "qa", label: "QA" },
      { id: "devops", label: "DevOps" },
    ],
    edges: [
      { from: "develop", to: "arch" },
      { from: "arch", to: "qa" },
      { from: "qa", to: "devops" },
      { from: "arch", to: "develop", back: true },
      { from: "qa", to: "develop", back: true },
    ],
  },
};
