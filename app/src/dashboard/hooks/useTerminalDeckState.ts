import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { DashboardBackend, PlainTerminal, Session } from "../../platform";
import { sameStringArray, sameStringRecord } from "../model/catalogEquality";
import type { Selection } from "../model/selection";
import { terminalSessionKey } from "../model/terminalIdentity";
import type { FullCatalogPublished } from "./useWorkspaceCatalog";

const PRELOAD_HISTORY_LINES = 300;

type TerminalDeckController = {
  openedSessions: string[];
  setOpenedSessions: Dispatch<SetStateAction<string[]>>;
  openedTerminals: string[];
  setOpenedTerminals: Dispatch<SetStateAction<string[]>>;
  tmuxPreviews: Record<string, string>;
  setTmuxPreviews: Dispatch<SetStateAction<Record<string, string>>>;
  cwdsBySession: Record<string, string>;
  setCwdsBySession: Dispatch<SetStateAction<Record<string, string>>>;
  cwdRequested: MutableRefObject<Set<string>>;
  tmuxPreviewRequested: MutableRefObject<Set<string>>;
  tmuxPreviewLiveRef: MutableRefObject<Set<string>>;
  handleFullCatalogPublished(publication: FullCatalogPublished): void;
};

type TerminalDeckPreviewInputs = {
  sessions: Session[];
  allTerminals: PlainTerminal[];
};

type TerminalDeckAttachInputs = {
  selection: Selection;
  selectedSession: Session | null;
  selectedTerminal: PlainTerminal | null;
  selectionMetadataPending: boolean;
  allTerminals: PlainTerminal[];
};

export function useTerminalDeckState(): TerminalDeckController {
  const [openedSessions, setOpenedSessions] = useState<string[]>([]);
  const [openedTerminals, setOpenedTerminals] = useState<string[]>([]);
  const [tmuxPreviews, setTmuxPreviews] = useState<Record<string, string>>({});
  const [cwdsBySession, setCwdsBySession] = useState<Record<string, string>>({});
  const cwdRequested = useRef<Set<string>>(new Set());
  const tmuxPreviewRequested = useRef<Set<string>>(new Set());
  const tmuxPreviewLiveRef = useRef<Set<string>>(new Set());

  const handleFullCatalogPublished = useCallback(({
    sessionNames,
  }: FullCatalogPublished) => {
    const live = new Set(sessionNames);
    setOpenedSessions((previous) => {
      const next = previous.filter((name) => live.has(name));
      return sameStringArray(previous, next) ? previous : next;
    });
    setCwdsBySession((previous) => {
      const next: Record<string, string> = {};
      for (const [name, cwd] of Object.entries(previous)) {
        if (live.has(name)) next[name] = cwd;
      }
      return sameStringRecord(previous, next) ? previous : next;
    });
  }, []);

  return {
    openedSessions,
    setOpenedSessions,
    openedTerminals,
    setOpenedTerminals,
    tmuxPreviews,
    setTmuxPreviews,
    cwdsBySession,
    setCwdsBySession,
    cwdRequested,
    tmuxPreviewRequested,
    tmuxPreviewLiveRef,
    handleFullCatalogPublished,
  };
}

export function useTerminalDeckPreviewPhase(
  controller: TerminalDeckController,
  dashboardBackend: Pick<DashboardBackend, "sessions">,
  { sessions, allTerminals }: TerminalDeckPreviewInputs,
): void {
  const {
    setTmuxPreviews,
    tmuxPreviewLiveRef,
    tmuxPreviewRequested,
  } = controller;

  useEffect(() => {
    const names = [
      ...sessions.map((session) => session.name),
      ...allTerminals.map(terminalSessionKey),
    ];
    const live = new Set(names);
    tmuxPreviewLiveRef.current = live;
    for (const name of Array.from(tmuxPreviewRequested.current)) {
      if (!live.has(name)) tmuxPreviewRequested.current.delete(name);
    }
    setTmuxPreviews((prev) => {
      const next: Record<string, string> = {};
      for (const [name, history] of Object.entries(prev)) {
        if (live.has(name)) next[name] = history;
      }
      return sameStringRecord(prev, next) ? prev : next;
    });

    (async () => {
      for (const name of names) {
        if (tmuxPreviewRequested.current.has(name)) continue;
        tmuxPreviewRequested.current.add(name);
        const history = await dashboardBackend.sessions
          .captureHistory(name, PRELOAD_HISTORY_LINES)
          .catch(() => "");
        if (!tmuxPreviewLiveRef.current.has(name)) {
          tmuxPreviewRequested.current.delete(name);
          continue;
        }
        setTmuxPreviews((prev) => (
          prev[name] === history ? prev : { ...prev, [name]: history }
        ));
      }
    })();
  }, [sessions, allTerminals]);
}

export function useTerminalDeckAttachPhase(
  controller: TerminalDeckController,
  dashboardBackend: Pick<DashboardBackend, "sessions">,
  {
    selection,
    selectedSession,
    selectedTerminal,
    selectionMetadataPending,
    allTerminals,
  }: TerminalDeckAttachInputs,
): void {
  const {
    cwdRequested,
    cwdsBySession,
    setCwdsBySession,
    setOpenedSessions,
    setOpenedTerminals,
  } = controller;

  useEffect(() => {
    if (selection?.kind !== "session") return;
    if (!selectedSession || selectionMetadataPending) return;
    const name = selection.name;
    setOpenedSessions((prev) =>
      prev.includes(name) ? prev : [...prev, name],
    );
    if (cwdsBySession[name] || cwdRequested.current.has(name)) return;
    cwdRequested.current.add(name);
    dashboardBackend.sessions.root(name)
      .then((cwd) => {
        if (cwd) setCwdsBySession((prev) => ({ ...prev, [name]: cwd }));
      })
      .catch(() => {})
      .finally(() => {
        cwdRequested.current.delete(name);
      });
  }, [dashboardBackend, selection, selectedSession, selectionMetadataPending, cwdsBySession]);

  useEffect(() => {
    if (selection?.kind !== "terminal") return;
    if (!selectedTerminal || selectionMetadataPending) return;
    const id = selection.id;
    setOpenedTerminals((prev) =>
      prev.includes(id) ? prev : [...prev, id],
    );
  }, [selection, selectedTerminal, selectionMetadataPending]);

  useEffect(() => {
    const liveTerminalIds = new Set(allTerminals.map((terminal) => terminal.id));
    setOpenedTerminals((prev) => {
      const next = prev.filter((id) => liveTerminalIds.has(id));
      return sameStringArray(prev, next) ? prev : next;
    });
  }, [allTerminals]);
}
