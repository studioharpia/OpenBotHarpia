import { useText } from "@openbot/ui/text";

/** The title of the empty page. The second line ends on one handwritten word, written once. */
export function TasksEmptyPitch() {
  const { t } = useText();
  const title = () => {
    const marker = "\u0000";
    const [before = "", after = ""] = t("conversation.tasks.empty.title", { answer: marker }).split(marker);
    return { before, after };
  };
  return (
    <div class="tasks-page-empty-pitch">
      <h3 class="tasks-page-empty-title">
        <span class="tasks-page-empty-lead">{t("conversation.tasks.empty.lead")}</span>
        <span>
          {title().before}
          <span class="tasks-page-empty-word">{t("conversation.tasks.empty.answer")}</span>
          {title().after}
        </span>
      </h3>
      <p class="tasks-page-empty-lines">
        <span>{t("conversation.tasks.empty.together")}</span>
        <span>{t("conversation.tasks.empty.waits")}</span>
      </p>
    </div>
  );
}
