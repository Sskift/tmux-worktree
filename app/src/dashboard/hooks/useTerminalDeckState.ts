import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import {
  createOwnerEpochLeaseController,
  type OwnerEpochLease,
  type OwnerEpochLeaseController,
} from "../ownerEpochLease";

const PRELOAD_HISTORY_LINES = 300;

type TerminalDeckController = {
  ownerEpochKey: string;
  ownerPhase: TerminalDeckOwnerPhaseHandle;
  openedSessions: string[];
  setOpenedSessions: Dispatch<SetStateAction<string[]>>;
  openedTerminals: string[];
  setOpenedTerminals: Dispatch<SetStateAction<string[]>>;
  tmuxPreviews: Record<string, string>;
  setTmuxPreviews: Dispatch<SetStateAction<Record<string, string>>>;
  cwdsBySession: Record<string, string>;
  setCwdsBySession: Dispatch<SetStateAction<Record<string, string>>>;
  cwdRequested: MutableRefObject<Map<string, TerminalDeckRequest>>;
  tmuxPreviewRequested: MutableRefObject<Map<string, TerminalDeckRequest>>;
  tmuxPreviewLiveRef: MutableRefObject<Map<string, string>>;
  handleFullCatalogPublished(publication: TerminalDeckCatalogPublication): void;
};

type TerminalDeckCatalogPublication = Readonly<{
  generation: number;
  sessionNames: string[];
}>;

type TerminalDeckRequest = Readonly<{
  lease: OwnerEpochLease<DashboardBackend>;
  incarnation: string;
  token: symbol;
}>;

type TerminalDeckPublishedOwner = Readonly<{
  owner: DashboardBackend;
  epoch: number;
}>;

type TerminalDeckRegistration = {
  fence: OwnerEpochLeaseController<DashboardBackend>;
  committedBackend: DashboardBackend | null;
  terminalIncarnations: WeakMap<object, number>;
  nextTerminalIncarnation: number;
};

type TerminalDeckOwnerPhaseHandle = Readonly<{
  registration: TerminalDeckRegistration;
  setPublishedOwner: Dispatch<SetStateAction<TerminalDeckPublishedOwner | null>>;
  setOpenedSessions: Dispatch<SetStateAction<string[]>>;
  setOpenedTerminals: Dispatch<SetStateAction<string[]>>;
  setTmuxPreviews: Dispatch<SetStateAction<Record<string, string>>>;
  setCwdsBySession: Dispatch<SetStateAction<Record<string, string>>>;
  cwdRequested: MutableRefObject<Map<string, TerminalDeckRequest>>;
  cwdIncarnations: MutableRefObject<Map<string, string>>;
  tmuxPreviewRequested: MutableRefObject<Map<string, TerminalDeckRequest>>;
  tmuxPreviewLiveRef: MutableRefObject<Map<string, string>>;
  tmuxPreviewIncarnations: MutableRefObject<Map<string, string>>;
}>;

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

function sessionIncarnation(session: Session): string {
  return JSON.stringify([
    "session",
    session.name,
    session.created,
    session.hostId ?? null,
    session.rawName ?? session.name,
  ]);
}

function terminalIncarnation(
  registration: TerminalDeckRegistration,
  terminal: PlainTerminal,
): string {
  let objectIncarnation = registration.terminalIncarnations.get(terminal);
  if (objectIncarnation === undefined) {
    objectIncarnation = registration.nextTerminalIncarnation;
    registration.nextTerminalIncarnation += 1;
    registration.terminalIncarnations.set(terminal, objectIncarnation);
  }
  return JSON.stringify([
    "terminal",
    terminal.id,
    terminal.tmuxName,
    terminal.hostId ?? null,
    terminal.rawName ?? terminal.tmuxName,
    objectIncarnation,
  ]);
}

function resolveStateAction<State>(
  action: SetStateAction<State>,
  previous: State,
): State {
  return typeof action === "function"
    ? (action as (value: State) => State)(previous)
    : action;
}

export function useTerminalDeckState(
  dashboardBackend: DashboardBackend,
): TerminalDeckController {
  const [openedSessions, setOpenedSessions] = useState<string[]>([]);
  const [openedTerminals, setOpenedTerminals] = useState<string[]>([]);
  const [tmuxPreviews, setTmuxPreviews] = useState<Record<string, string>>({});
  const [cwdsBySession, setCwdsBySession] = useState<Record<string, string>>({});
  const cwdRequested = useRef<Map<string, TerminalDeckRequest>>(new Map());
  const cwdIncarnations = useRef<Map<string, string>>(new Map());
  const tmuxPreviewRequested = useRef<Map<string, TerminalDeckRequest>>(new Map());
  const tmuxPreviewLiveRef = useRef<Map<string, string>>(new Map());
  const tmuxPreviewIncarnations = useRef<Map<string, string>>(new Map());
  const [publishedOwner, setPublishedOwner] = useState<TerminalDeckPublishedOwner | null>(null);
  const [registration] = useState<TerminalDeckRegistration>(() => ({
    fence: createOwnerEpochLeaseController<DashboardBackend>(),
    committedBackend: null,
    terminalIncarnations: new WeakMap(),
    nextTerminalIncarnation: 1,
  }));
  const [ownerPhase] = useState<TerminalDeckOwnerPhaseHandle>(() => ({
    registration,
    setPublishedOwner,
    setOpenedSessions,
    setOpenedTerminals,
    setTmuxPreviews,
    setCwdsBySession,
    cwdRequested,
    cwdIncarnations,
    tmuxPreviewRequested,
    tmuxPreviewLiveRef,
    tmuxPreviewIncarnations,
  }));
  const lease = registration.fence.capture(dashboardBackend);
  const ownerVisible = !!lease &&
    publishedOwner?.owner === lease.owner &&
    publishedOwner.epoch === lease.epoch;
  const ownerEpochKey = ownerVisible
    ? `terminal-deck-owner-${lease.epoch}`
    : "terminal-deck-owner-pending";

  const setOpenedSessionsForOwner = useCallback<Dispatch<SetStateAction<string[]>>>((action) => {
    if (!lease) return;
    setOpenedSessions((previous) => (
      registration.fence.isCurrent(lease)
        ? resolveStateAction(action, previous)
        : previous
    ));
  }, [lease, registration]);
  const setOpenedTerminalsForOwner = useCallback<Dispatch<SetStateAction<string[]>>>((action) => {
    if (!lease) return;
    setOpenedTerminals((previous) => (
      registration.fence.isCurrent(lease)
        ? resolveStateAction(action, previous)
        : previous
    ));
  }, [lease, registration]);
  const setTmuxPreviewsForOwner = useCallback<Dispatch<SetStateAction<Record<string, string>>>>((action) => {
    if (!lease) return;
    setTmuxPreviews((previous) => (
      registration.fence.isCurrent(lease)
        ? resolveStateAction(action, previous)
        : previous
    ));
  }, [lease, registration]);
  const setCwdsBySessionForOwner = useCallback<Dispatch<SetStateAction<Record<string, string>>>>((action) => {
    if (!lease) return;
    setCwdsBySession((previous) => (
      registration.fence.isCurrent(lease)
        ? resolveStateAction(action, previous)
        : previous
    ));
  }, [lease, registration]);

  const handleFullCatalogPublished = useCallback(({
    sessionNames,
  }: TerminalDeckCatalogPublication) => {
    if (!lease || !registration.fence.isCurrent(lease)) return;
    const live = new Set(sessionNames);
    setOpenedSessions((previous) => {
      if (!registration.fence.isCurrent(lease)) return previous;
      const next = previous.filter((name) => live.has(name));
      return sameStringArray(previous, next) ? previous : next;
    });
    setCwdsBySession((previous) => {
      if (!registration.fence.isCurrent(lease)) return previous;
      const next: Record<string, string> = {};
      for (const [name, cwd] of Object.entries(previous)) {
        if (live.has(name)) next[name] = cwd;
      }
      return sameStringRecord(previous, next) ? previous : next;
    });
    for (const name of Array.from(cwdRequested.current.keys())) {
      if (!live.has(name)) cwdRequested.current.delete(name);
    }
    for (const name of Array.from(cwdIncarnations.current.keys())) {
      if (!live.has(name)) cwdIncarnations.current.delete(name);
    }
  }, [lease, registration]);

  return {
    ownerEpochKey,
    ownerPhase,
    openedSessions: ownerVisible ? openedSessions : [],
    setOpenedSessions: setOpenedSessionsForOwner,
    openedTerminals: ownerVisible ? openedTerminals : [],
    setOpenedTerminals: setOpenedTerminalsForOwner,
    tmuxPreviews: ownerVisible ? tmuxPreviews : {},
    setTmuxPreviews: setTmuxPreviewsForOwner,
    cwdsBySession: ownerVisible ? cwdsBySession : {},
    setCwdsBySession: setCwdsBySessionForOwner,
    cwdRequested,
    tmuxPreviewRequested,
    tmuxPreviewLiveRef,
    handleFullCatalogPublished,
  };
}

export function useTerminalDeckOwnerPhase(
  ownerPhase: TerminalDeckOwnerPhaseHandle,
  dashboardBackend: DashboardBackend,
): void {
  const {
    registration,
    setPublishedOwner,
    setOpenedSessions,
    setOpenedTerminals,
    setTmuxPreviews,
    setCwdsBySession,
    cwdRequested,
    cwdIncarnations,
    tmuxPreviewRequested,
    tmuxPreviewLiveRef,
    tmuxPreviewIncarnations,
  } = ownerPhase;

  useLayoutEffect(() => {
    registration.committedBackend = dashboardBackend;
    const ownerCommit = registration.fence.commit(dashboardBackend);
    if (!ownerCommit.changed) return;
    registration.terminalIncarnations = new WeakMap();
    registration.nextTerminalIncarnation = 1;
    setOpenedSessions([]);
    setOpenedTerminals([]);
    setTmuxPreviews({});
    setCwdsBySession({});
    cwdRequested.current = new Map();
    cwdIncarnations.current = new Map();
    tmuxPreviewRequested.current = new Map();
    tmuxPreviewLiveRef.current = new Map();
    tmuxPreviewIncarnations.current = new Map();
    setPublishedOwner(ownerCommit.lease);
  }, [dashboardBackend, ownerPhase, registration]);

  useLayoutEffect(() => {
    const activation = registration.fence.activate();
    const lease = registration.committedBackend
      ? registration.fence.capture(registration.committedBackend)
      : null;
    setPublishedOwner(lease);
    return () => {
      if (!registration.fence.deactivate(activation)) return;
      cwdRequested.current = new Map();
      tmuxPreviewRequested.current = new Map();
      tmuxPreviewLiveRef.current = new Map();
    };
  }, [ownerPhase, registration]);
}

export function useTerminalDeckPreviewPhase(
  controller: TerminalDeckController,
  dashboardBackend: DashboardBackend,
  { sessions, allTerminals }: TerminalDeckPreviewInputs,
): void {
  const {
    ownerPhase,
    tmuxPreviewLiveRef,
    tmuxPreviewRequested,
  } = controller;

  useEffect(() => {
    const { registration, setTmuxPreviews, tmuxPreviewIncarnations } = ownerPhase;
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease) return;
    const entities = [
      ...sessions.map((session) => ({
        name: session.name,
        incarnation: sessionIncarnation(session),
      })),
      ...allTerminals.map((terminal) => ({
        name: terminalSessionKey(terminal),
        incarnation: terminalIncarnation(registration, terminal),
      })),
    ];
    const live = new Map<string, string>();
    for (const entity of entities) {
      if (!live.has(entity.name)) live.set(entity.name, entity.incarnation);
    }
    tmuxPreviewLiveRef.current = live;
    for (const [name, request] of Array.from(tmuxPreviewRequested.current.entries())) {
      if (
        !live.has(name) ||
        live.get(name) !== request.incarnation ||
        !registration.fence.isCurrent(request.lease)
      ) {
        tmuxPreviewRequested.current.delete(name);
      }
    }
    for (const [name, incarnation] of Array.from(tmuxPreviewIncarnations.current.entries())) {
      if (live.get(name) !== incarnation) tmuxPreviewIncarnations.current.delete(name);
    }
    setTmuxPreviews((prev) => {
      if (!registration.fence.isCurrent(lease)) return prev;
      const next: Record<string, string> = {};
      for (const [name, history] of Object.entries(prev)) {
        if (
          live.has(name) &&
          tmuxPreviewIncarnations.current.get(name) === live.get(name)
        ) {
          next[name] = history;
        }
      }
      return sameStringRecord(prev, next) ? prev : next;
    });

    (async () => {
      for (const { name, incarnation } of entities) {
        if (!registration.fence.isCurrent(lease)) return;
        if (tmuxPreviewLiveRef.current.get(name) !== incarnation) continue;
        if (tmuxPreviewIncarnations.current.get(name) === incarnation) continue;
        const existing = tmuxPreviewRequested.current.get(name);
        if (
          existing &&
          existing.incarnation === incarnation &&
          registration.fence.isCurrent(existing.lease)
        ) {
          continue;
        }
        const request: TerminalDeckRequest = {
          lease,
          incarnation,
          token: Symbol(name),
        };
        tmuxPreviewRequested.current.set(name, request);
        const history = await dashboardBackend.sessions
          .captureHistory(name, PRELOAD_HISTORY_LINES)
          .catch(() => "");
        if (
          !registration.fence.isCurrent(lease) ||
          tmuxPreviewRequested.current.get(name) !== request ||
          tmuxPreviewLiveRef.current.get(name) !== incarnation
        ) {
          continue;
        }
        tmuxPreviewIncarnations.current.set(name, incarnation);
        setTmuxPreviews((prev) => (
          registration.fence.isCurrent(lease) &&
          tmuxPreviewRequested.current.get(name) === request
            ? (prev[name] === history ? prev : { ...prev, [name]: history })
            : prev
        ));
      }
    })();
  }, [dashboardBackend, sessions, allTerminals]);
}

export function useTerminalDeckAttachPhase(
  controller: TerminalDeckController,
  dashboardBackend: DashboardBackend,
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
    ownerPhase,
  } = controller;

  useEffect(() => {
    if (selection?.kind !== "session") return;
    if (!selectedSession || selectionMetadataPending) return;
    const {
      registration,
      setOpenedSessions,
      setCwdsBySession,
      cwdIncarnations,
    } = ownerPhase;
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease) return;
    const name = selection.name;
    const incarnation = sessionIncarnation(selectedSession);
    setOpenedSessions((prev) => {
      if (!registration.fence.isCurrent(lease)) return prev;
      return prev.includes(name) ? prev : [...prev, name];
    });
    const existing = cwdRequested.current.get(name);
    const existingIsCurrent = !!existing &&
      existing.incarnation === incarnation &&
      registration.fence.isCurrent(existing.lease);
    if (
      cwdIncarnations.current.get(name) === incarnation &&
      existingIsCurrent
    ) {
      return;
    }
    setCwdsBySession((prev) => {
      if (!registration.fence.isCurrent(lease) || !(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
    cwdIncarnations.current.delete(name);
    if (existingIsCurrent) return;
    const request: TerminalDeckRequest = {
      lease,
      incarnation,
      token: Symbol(name),
    };
    cwdRequested.current.set(name, request);
    dashboardBackend.sessions.root(name)
      .then((cwd) => {
        if (
          !registration.fence.isCurrent(lease) ||
          cwdRequested.current.get(name) !== request
        ) {
          return;
        }
        if (!cwd) {
          cwdRequested.current.delete(name);
          return;
        }
        cwdIncarnations.current.set(name, incarnation);
        setCwdsBySession((prev) => (
          registration.fence.isCurrent(lease) &&
          cwdRequested.current.get(name) === request
            ? { ...prev, [name]: cwd }
            : prev
        ));
      })
      .catch(() => {
        if (cwdRequested.current.get(name) === request) {
          cwdRequested.current.delete(name);
        }
      });
  }, [dashboardBackend, selection, selectedSession, selectionMetadataPending]);

  useEffect(() => {
    if (selection?.kind !== "terminal") return;
    if (!selectedTerminal || selectionMetadataPending) return;
    const { registration, setOpenedTerminals } = ownerPhase;
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease) return;
    const id = selection.id;
    setOpenedTerminals((prev) => {
      if (!registration.fence.isCurrent(lease)) return prev;
      return prev.includes(id) ? prev : [...prev, id];
    });
  }, [dashboardBackend, selection, selectedTerminal, selectionMetadataPending]);

  useEffect(() => {
    const { registration, setOpenedTerminals } = ownerPhase;
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease) return;
    const liveTerminalIds = new Set(allTerminals.map((terminal) => terminal.id));
    setOpenedTerminals((prev) => {
      if (!registration.fence.isCurrent(lease)) return prev;
      const next = prev.filter((id) => liveTerminalIds.has(id));
      return sameStringArray(prev, next) ? prev : next;
    });
  }, [dashboardBackend, allTerminals]);
}
