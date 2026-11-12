import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { ComposerTemplatesContext, type PromptTemplate } from "@openbot/ui/features/templates/composer-templates";
import { createSignal, onSettled, type ParentProps } from "solid-js";
import { createSimpleContext } from "../../simple-context";

const KEY = "openbot:prompt-templates:v1";

function readTemplates(): PromptTemplate[] {
  const raw = window.localStorage.getItem(KEY);
  if (raw === null) return [];
  return decodeTemplates(JSON.parse(raw));
}

function decodeTemplates(values: unknown): PromptTemplate[] {
  if (!Array.isArray(values)) throw new Error("Invalid prompt templates");
  const templates: PromptTemplate[] = [];
  for (const item of values) {
    if (
      !isDynamicRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.prompt !== "string" ||
      !item.id ||
      !item.name.trim() ||
      !item.prompt.trim() ||
      item.prompt.length > INPUT_LIMITS.messageText
    )
      throw new Error("Invalid prompt template");
    templates.push({ id: item.id, name: item.name, prompt: item.prompt });
  }
  return templates;
}

const context = createSimpleContext({
  name: "PromptTemplates",
  init: () => {
    let initial: PromptTemplate[] = [];
    let loadFailed = false;
    try {
      initial = readTemplates();
    } catch {
      loadFailed = true;
    }
    const [items, setItems] = createSignal<PromptTemplate[]>(initial);
    const [error, setError] = createSignal(loadFailed);
    function refresh() {
      try {
        setItems(readTemplates());
        setError(false);
      } catch {
        setError(true);
      }
    }
    onSettled(() => {
      const changed = (event: StorageEvent) => {
        if (event.key === KEY || event.key === null) refresh();
      };
      window.addEventListener("storage", changed);
      return () => window.removeEventListener("storage", changed);
    });
    function change(update: (current: PromptTemplate[]) => PromptTemplate[]): boolean {
      try {
        const next = update(readTemplates());
        window.localStorage.setItem(KEY, JSON.stringify(next));
        setItems(next);
        setError(false);
        return true;
      } catch {
        setError(true);
        return false;
      }
    }
    return {
      items,
      error,
      save(template: PromptTemplate) {
        if (!template.name.trim() || !template.prompt.trim() || template.prompt.length > INPUT_LIMITS.messageText)
          return false;
        return change((current) => {
          const found = current.some((item) => item.id === template.id);
          const value = { ...template, name: template.name.trim() };
          return found ? current.map((item) => (item.id === template.id ? value : item)) : [...current, value];
        });
      },
      remove: (id: string) => change((current) => current.filter((item) => item.id !== id)),
    };
  },
});

function ComposerTemplatesScope(props: ParentProps) {
  const templates = context.use();
  return <ComposerTemplatesContext value={templates.items}>{props.children}</ComposerTemplatesContext>;
}

export function PromptTemplatesProvider(props: ParentProps) {
  return (
    <context.provider>
      <ComposerTemplatesScope>{props.children}</ComposerTemplatesScope>
    </context.provider>
  );
}
export const usePromptTemplates = context.use;
