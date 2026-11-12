import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  Button,
  buttonVariants,
  Card,
  ConfirmDialog,
  ContextMenu,
  Dialog,
  DropdownMenu,
  Ellipsis,
  FileText,
  IconButton,
  Input,
  PencilLine,
  Plus,
  Textarea,
  Trash2,
  X,
} from "@openbot/ui";
import { SettingsField } from "@openbot/ui/components/SettingsPanel";
import type { PromptTemplate } from "@openbot/ui/features/templates/composer-templates";
import { useText } from "@openbot/ui/text";
import { createSignal, createStore, For, Show } from "solid-js";
import { usePromptTemplates } from "./templates-context";
import "./templates.css";

export function TemplatesPage() {
  const { t } = useText();
  const templates = usePromptTemplates();
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createStore<PromptTemplate>({ id: "", name: "", prompt: "" });
  const [deleting, setDeleting] = createSignal<PromptTemplate | null>(null);
  let nameField: HTMLInputElement | undefined;
  function edit(item?: PromptTemplate) {
    setDraft(() => (item ? { ...item } : { id: crypto.randomUUID(), name: "", prompt: "" }));
    setEditing(true);
  }
  return (
    <main class="templates-page" aria-label={t("app.rail.templates")}>
      <div class="templates-page-content">
        <header class="templates-page-header">
          <div>
            <h1>{t("app.rail.templates")}</h1>
            <p>{t("composer.templates.hint")}</p>
          </div>
          <Button onClick={() => edit()}>
            <Plus aria-hidden="true" />
            {t("composer.templates.new")}
          </Button>
        </header>
        <Show when={templates.error()}>
          <p role="alert">{t("composer.templates.storageError")}</p>
        </Show>
        <div class="templates-grid">
          <For each={templates.items()} fallback={<p class="templates-empty">{t("composer.templates.empty")}</p>}>
            {(item) => (
              <ContextMenu.Root>
                <Card class="template-card">
                  <ContextMenu.Trigger class="template-card-context">
                    <Button
                      variant="ghost"
                      class="template-card-open"
                      onClick={() => edit(item)}
                      aria-label={item.name}
                    >
                      <span class="template-card-preview">{item.prompt}</span>
                      <span class="template-card-footer">
                        <FileText aria-hidden="true" />
                        <strong>{item.name}</strong>
                      </span>
                    </Button>
                  </ContextMenu.Trigger>
                  <DropdownMenu.Root placement="bottom-end">
                    <DropdownMenu.Trigger
                      class={[buttonVariants({ variant: "ghost", size: "icon-sm" }), "template-card-menu"]}
                      aria-label={t("composer.templates.actions")}
                    >
                      <Ellipsis aria-hidden="true" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item onSelectAfterClose={() => edit(item)}>
                          <PencilLine aria-hidden="true" />
                          {t("common.edit")}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item class="ui-action-menu-danger" onSelectAfterClose={() => setDeleting(item)}>
                          <Trash2 aria-hidden="true" />
                          {t("common.delete")}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </Card>
                <ContextMenu.Portal>
                  <ContextMenu.Content>
                    <ContextMenu.Item onSelectAfterClose={() => edit(item)}>
                      <PencilLine aria-hidden="true" />
                      {t("common.edit")}
                    </ContextMenu.Item>
                    <ContextMenu.Item class="ui-action-menu-danger" onSelectAfterClose={() => setDeleting(item)}>
                      <Trash2 aria-hidden="true" />
                      {t("common.delete")}
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            )}
          </For>
        </div>
      </div>
      <Dialog.Root open={editing()} onOpenChange={setEditing}>
        <Dialog.Portal>
          <Dialog.Overlay class="ui-confirm-dialog-overlay">
            <Dialog.Content
              as="section"
              class="ui-confirm-dialog templates-dialog"
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                nameField?.focus({ preventScroll: true });
              }}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (templates.save({ ...draft })) setEditing(false);
                }}
              >
                <header class="templates-dialog-header">
                  <div>
                    <Dialog.Title as="h2" class="ui-confirm-dialog-title">
                      {t("composer.templates.editor")}
                    </Dialog.Title>
                    <Dialog.Description class="ui-confirm-dialog-description">
                      {t("composer.templates.hint")}
                    </Dialog.Description>
                  </div>
                  <IconButton variant="ghost" label={t("common.close")} onClick={() => setEditing(false)}>
                    <X aria-hidden="true" />
                  </IconButton>
                </header>
                <div class="templates-dialog-body">
                  <SettingsField label={t("composer.templates.name")}>
                    <Input
                      ref={(field: HTMLInputElement) => {
                        nameField = field;
                      }}
                      value={draft.name}
                      maxlength={120}
                      required
                      onInput={(event) =>
                        setDraft((draft) => {
                          draft.name = event.currentTarget.value;
                        })
                      }
                    />
                  </SettingsField>
                  <SettingsField label={t("composer.templates.prompt")}>
                    <Textarea
                      value={draft.prompt}
                      maxlength={INPUT_LIMITS.messageText}
                      required
                      rows={10}
                      onInput={(event) =>
                        setDraft((draft) => {
                          draft.prompt = event.currentTarget.value;
                        })
                      }
                    />
                  </SettingsField>
                  <Show when={templates.error()}>
                    <p role="alert">{t("composer.templates.storageError")}</p>
                  </Show>
                </div>
                <footer class="ui-confirm-dialog-actions">
                  <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" disabled={!draft.name.trim() || !draft.prompt.trim()}>
                    {t("common.save")}
                  </Button>
                </footer>
              </form>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={deleting() !== null}
        onCancel={() => setDeleting(null)}
        title={t("composer.templates.delete")}
        description={deleting()?.name}
        confirmLabel={t("common.delete")}
        error={templates.error() ? t("composer.templates.storageError") : undefined}
        onConfirm={() => {
          const item = deleting();
          if (item && templates.remove(item.id)) setDeleting(null);
        }}
      />
    </main>
  );
}
