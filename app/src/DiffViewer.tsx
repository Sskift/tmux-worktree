import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  cwd: string;
  filePath: string;
  onClose: () => void;
};

type DiffLine = {
  type: "add" | "del" | "context" | "hunk" | "header";
  content: string;
  oldNum: number | null;
  newNum: number | null;
};

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: "hunk", content: line, oldNum: null, newNum: null });
    } else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      result.push({ type: "header", content: line, oldNum: null, newNum: null });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), oldNum: null, newNum: newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "del", content: line.slice(1), oldNum: oldLine, newNum: null });
      oldLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      result.push({ type: "context", content: line, oldNum: null, newNum: null });
    } else {
      // context line (starts with space or is empty)
      const content = line.startsWith(" ") ? line.slice(1) : line;
      if (oldLine > 0 || newLine > 0) {
        result.push({ type: "context", content, oldNum: oldLine, newNum: newLine });
        oldLine++;
        newLine++;
      }
    }
  }

  return result;
}

export function DiffViewer({ cwd, filePath, onClose }: Props) {
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<string>("git_diff", { cwd, path: filePath });
      setDiff(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd, filePath]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  const fileName = filePath.split("/").pop() ?? filePath;
  const lines = parseDiff(diff);

  return (
    <div className="pane pane--term">
      <div className="pane__bar">
        <span className="pane__title file-editor__title">{fileName}</span>
        <span className="pane__hint dim">diff</span>
        <div className="file-editor__actions">
          <button className="btn btn--small" type="button" onClick={onClose} title="close">
            ×
          </button>
        </div>
      </div>
      <div className="pane__body" style={{ padding: 0 }}>
        {loading ? (
          <div className="file-editor__status">loading diff...</div>
        ) : error ? (
          <div className="file-editor__status file-editor__status--error">{error}</div>
        ) : diff.trim() === "" ? (
          <div className="file-editor__status">no changes</div>
        ) : (
          <div className="diff-viewer">
            {lines.map((line, i) => (
              <div key={i} className={`diff-line diff-line--${line.type}`}>
                <span className="diff-line__num">
                  {line.oldNum ?? ""}
                </span>
                <span className="diff-line__num">
                  {line.newNum ?? ""}
                </span>
                <span className="diff-line__content">{line.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
