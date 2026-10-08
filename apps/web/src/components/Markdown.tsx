import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer" />;
  },
  pre({ node: _node, ...props }) {
    return <pre {...props} className={cn("overflow-x-auto", props.className)} />;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="overflow-x-auto">
        <table {...props} />
      </div>
    );
  },
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose prose-sm max-w-none wrap-break-word dark:prose-invert", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
