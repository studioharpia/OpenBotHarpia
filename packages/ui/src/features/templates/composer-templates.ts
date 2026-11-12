import { type Accessor, createContext } from "solid-js";

/** Plain prompt text; selecting one replaces the editor draft without submitting it. */
export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

/** The host supplies data through this typed composition slot; shared UI owns no persistence. */
export const ComposerTemplatesContext = createContext<Accessor<readonly PromptTemplate[]>>();
