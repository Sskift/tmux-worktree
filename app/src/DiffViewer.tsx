import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useDashboardBackend } from "./platform";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "./latestRequestGate";

type Props = {
  cwd: string;
  filePath: string;
  hostId?: string | null;
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

export function DiffViewer({ cwd, filePath, hostId, onClose }: Props) {
  const dashboardBackend = useDashboardBackend();
  const sourceKey = requestSourceKey(hostId ?? null, cwd, filePath);
  const requestGateRef = useRef(createLatestRequestGate());
  const [result, setResult] = useState<{
    sourceKey: string;
    diff: string;
    loading: boolean;
    error: string | null;
  }>(() => ({ sourceKey, diff: "", loading: true, error: null }));

  useEffect(() => {
    const requestGate = requestGateRef.current;
    const request = requestGate.issue(sourceKey);
    setResult((current) => ({
      sourceKey,
      diff: current.sourceKey === sourceKey ? current.diff : "",
      loading: true,
      error: null,
    }));

    void dashboardBackend.git.diff(cwd, filePath, hostId)
      .then((diff) => {
        if (!requestGate.isCurrent(request)) return;
        setResult({ sourceKey, diff, loading: false, error: null });
      })
      .catch((error) => {
        if (!requestGate.isCurrent(request)) return;
        setResult({
          sourceKey,
          diff: "",
          loading: false,
          error: String(error),
        });
      });

    return () => requestGate.cancel(request);
  }, [cwd, dashboardBackend.git, filePath, hostId, sourceKey]);

  const currentResult = result.sourceKey === sourceKey
    ? result
    : { sourceKey, diff: "", loading: true, error: null };
  const { diff, loading, error } = currentResult;

  const fileName = filePath.split("/").pop() ?? filePath;
  const lines = parseDiff(diff);

  return (
    <div className="pane pane--term">
      <div className="pane__bar">
        <span className="pane__title diff-viewer__title">{fileName}</span>
        <span className="pane__hint dim">diff</span>
        <div className="diff-viewer__actions">
          <button className="btn btn--small" type="button" onClick={onClose} title="Close diff" aria-label="Close diff">
            <X aria-hidden="true" size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div className="pane__body" style={{ padding: 0 }}>
        {loading ? (
          <div className="diff-viewer__status">loading diff...</div>
        ) : error ? (
          <div className="diff-viewer__status diff-viewer__status--error">{error}</div>
        ) : diff.trim() === "" ? (
          <div className="diff-viewer__status">no changes</div>
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
