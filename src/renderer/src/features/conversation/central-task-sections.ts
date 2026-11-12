import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createStore } from "solid-js";

export type CentralTaskSection = "completed" | "active" | "archived";
type CentralTaskSections = Record<CentralTaskSection, boolean>;
const STORAGE_KEY = "openbot:central-task-sections";

function readCollapsedSections(): CentralTaskSections {
  const defaults = { completed: false, active: false, archived: true };
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!isDynamicRecord(value)) return defaults;
    return {
      completed: typeof value.completed === "boolean" ? value.completed : defaults.completed,
      active: typeof value.active === "boolean" ? value.active : defaults.active,
      archived: typeof value.archived === "boolean" ? value.archived : defaults.archived,
    };
  } catch {
    return defaults;
  }
}

// Device preference shared by every agent and host, including other chat windows.
const [collapsed, setCollapsed] = createStore(readCollapsedSections());
function readStorage(event: StorageEvent): void {
  if (event.key === null || event.key === STORAGE_KEY) setCollapsed(() => readCollapsedSections());
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", readStorage);
  import.meta.hot?.dispose(() => window.removeEventListener("storage", readStorage));
}
export function useCentralTaskSections(): Readonly<CentralTaskSections> {
  return collapsed;
}
export function setCentralTaskSectionCollapsed(section: CentralTaskSection, value: boolean): void {
  const next = { ...collapsed, [section]: value };
  setCollapsed(() => next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The shared page state still keeps the preference when storage is blocked or full.
  }
}
