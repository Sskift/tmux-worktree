import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  filePath: string;
  onClose: () => void;
};

export function FileEditor({ filePath, onClose }: Props) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pathRef = useRef(filePath);

  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const text = await invoke<string>("read_file", { path });
      if (pathRef.current === path) {
        setContent(text);
        setOriginalContent(text);
      }
    } catch (e) {
      if (pathRef.current === path) {
        setError(String(e));
        setContent("");
        setOriginalContent("");
      }
    } finally {
      if (pathRef.current === path) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    pathRef.current = filePath;
    loadFile(filePath);
  }, [filePath, loadFile]);

  const save = useCallback(async () => {
    if (saving || content === originalContent) return;
    setSaving(true);
    try {
      await invoke("write_file", { path: filePath, content });
      setOriginalContent(content);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [filePath, content, originalContent, saving]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  const isDirty = content !== originalContent;
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="pane pane--term">
      <div className="pane__bar">
        <span className="pane__title file-editor__title">
          {fileName}
          {isDirty && <span className="file-editor__modified" />}
        </span>
        <div className="file-editor__actions">
          {isDirty && (
            <button
              className="btn btn--small"
              type="button"
              onClick={save}
              disabled={saving}
              title="save (⌘S)"
            >
              {saving ? "..." : "save"}
            </button>
          )}
          <button
            className="btn btn--small"
            type="button"
            onClick={onClose}
            title="close"
          >
            ×
          </button>
        </div>
      </div>
      <div className="pane__body" style={{ padding: 0 }}>
        {loading ? (
          <div className="file-editor__status">loading...</div>
        ) : error ? (
          <div className="file-editor__status file-editor__status--error">{error}</div>
        ) : (
          <textarea
            ref={textareaRef}
            className="file-editor__textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        )}
      </div>
    </div>
  );
}
