import { type Accessor, createContext } from "solid-js";

/** Plain prompt text; selecting one replaces the editor draft without submitting it. */
export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

/** Optional host data; consumers without templates keep the composer available. */
export const ComposerTemplatesContext = createContext<Accessor<readonly PromptTemplate[]> | null>(null);
