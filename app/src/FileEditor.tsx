import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getFileCategory, getLanguageExtension } from "./fileUtils";
import { detectLinks, resolvePath, checkFileExists, openUrlInBrowser } from "./linkDetect";

type Props = {
  filePath: string;
  onClose: () => void;
  onOpenFile?: (path: string, line?: number, col?: number) => void;
};

/* ── Image Preview ──────────────────────────────────────────── */

function ImagePreview({ filePath, onClose }: Props) {
  const fileName = filePath.split("/").pop() ?? filePath;
  const src = convertFileSrc(filePath);

  return (
    <div className="pane pane--term">
      <div className="pane__bar">
        <span className="pane__title file-editor__title">{fileName}</span>
        <div className="file-editor__actions">
          <button className="btn btn--small" type="button" onClick={onClose} title="close">
            ×
          </button>
        </div>
      </div>
      <div className="pane__body file-editor__image">
        <img src={src} alt={fileName} />
      </div>
    </div>
  );
}

/* ── Code / Markdown Editor ─────────────────────────────────── */

function CodeEditor({ filePath, onClose, isMarkdown, onOpenFile }: Props & { isMarkdown: boolean }) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  const pathRef = useRef(filePath);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef("");
  const originalContentRef = useRef("");

  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setPreviewMode(false);
    try {
      const text = await invoke<string>("read_file", { path });
      if (pathRef.current === path) {
        setContent(text);
        setOriginalContent(text);
        contentRef.current = text;
        originalContentRef.current = text;
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
    const cur = contentRef.current;
    if (saving || cur === originalContentRef.current) return;
    setSaving(true);
    try {
      await invoke("write_file", { path: pathRef.current, content: cur });
      setOriginalContent(cur);
      originalContentRef.current = cur;
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [saving]);

  // CodeMirror setup
  useEffect(() => {
    if (!editorRef.current || loading || error || previewMode) return;

    let destroyed = false;

    const buildEditor = async () => {
      const langExt = await getLanguageExtension(filePath);
      if (destroyed) return;

      const extensions = [
        basicSetup,
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            contentRef.current = newContent;
            setContent(newContent);
          }
        }),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              save();
              return true;
            },
          },
        ]),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
        EditorView.domEventHandlers({
          click(event: MouseEvent, view: EditorView) {
            if (!event.metaKey) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const line = view.state.doc.lineAt(pos);
            const colInLine = pos - line.from;
            const links = detectLinks(line.text);
            const clicked = links.find(
              (l) => colInLine >= l.startIndex && colInLine < l.endIndex,
            );
            if (!clicked) return false;
            if (clicked.kind === "url") {
              openUrlInBrowser(clicked.url);
            } else if (clicked.kind === "file") {
              const dir = filePath.split("/").slice(0, -1).join("/");
              const resolved = resolvePath(clicked.path, dir);
              checkFileExists(resolved).then((exists) => {
                if (exists && onOpenFile) {
                  onOpenFile(resolved, clicked.line, clicked.col);
                }
              });
            }
            event.preventDefault();
            return true;
          },
        }),
      ];

      if (langExt) extensions.push(langExt);

      const state = EditorState.create({
        doc: contentRef.current,
        extensions,
      });

      viewRef.current = new EditorView({
        state,
        parent: editorRef.current!,
      });
    };

    buildEditor();

    return () => {
      destroyed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [filePath, loading, error, previewMode, save]);

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
          {isMarkdown && (
            <button
              className={`btn btn--small file-editor__toggle${previewMode ? " file-editor__toggle--active" : ""}`}
              type="button"
              onClick={() => setPreviewMode((v) => !v)}
              title={previewMode ? "edit" : "preview"}
            >
              {previewMode ? "edit" : "preview"}
            </button>
          )}
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
          <button className="btn btn--small" type="button" onClick={onClose} title="close">
            ×
          </button>
        </div>
      </div>
      <div className="pane__body" style={{ padding: 0 }}>
        {loading ? (
          <div className="file-editor__status">loading...</div>
        ) : error ? (
          <div className="file-editor__status file-editor__status--error">{error}</div>
        ) : previewMode ? (
          <div className="file-editor__markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        ) : (
          <div className="file-editor__cm" ref={editorRef} />
        )}
      </div>
    </div>
  );
}

/* ── Main Export ─────────────────────────────────────────────── */

export function FileEditor({ filePath, onClose, onOpenFile }: Props) {
  const category = getFileCategory(filePath);

  if (category === "image") {
    return <ImagePreview filePath={filePath} onClose={onClose} />;
  }

  return (
    <CodeEditor
      filePath={filePath}
      onClose={onClose}
      onOpenFile={onOpenFile}
      isMarkdown={category === "markdown"}
    />
  );
}
