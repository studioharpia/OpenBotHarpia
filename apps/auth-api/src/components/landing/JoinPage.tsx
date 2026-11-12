import { AppLogo } from "@openbot/brand";
import {
  createWebAppInvitePath,
  OPENBOT_INVITE_ORIGIN,
  selfHostedApiOrigin,
  toOpenBotInviteUrl,
} from "@openbot/contracts/invite-links";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { landingAnalytics } from "../../lib/analytics";
import { detectDownloadPlatform } from "../../lib/download-platforms";
import { OPENBOT_DOWNLOAD_LINKS } from "../../lib/landing-links";
import { createOpenAppFallback, OpenAppFallbackDialog } from "../transactional/OpenAppFallback";
import type { JoinLink, JoinPageText } from "../transactional/page-text";
import { TransactionalPage } from "../transactional/TransactionalPage";
import { Button } from "../ui/button";

export function JoinPage(props: { lang: string; text: JoinPageText; inviteUrl: string }) {
  // Resolve both links during SSR too: the invitation must remain usable when the browser
  // cannot load or run the page's JavaScript. Invalid links render their error immediately.
  const invite = createMemo(() => {
    try {
      const pageUrl = new URL(props.inviteUrl);
      const inviteLinks = { selfHostedApiOrigin: selfHostedApiOrigin(pageUrl.origin) };
      const canonicalUrl = new URL(
        `${pageUrl.pathname}${pageUrl.search}`,
        inviteLinks.selfHostedApiOrigin ?? OPENBOT_INVITE_ORIGIN,
      ).toString();
      return {
        openUrl: toOpenBotInviteUrl(canonicalUrl, inviteLinks),
        browserUrl: createWebAppInvitePath(canonicalUrl, inviteLinks),
      };
    } catch {
      return null;
    }
  });
  const [downloadUrl, setDownloadUrl] = createSignal<string>(OPENBOT_DOWNLOAD_LINKS.macos);
  const [mobile, setMobile] = createSignal(false);
  const fallback = createOpenAppFallback();

  onSettled(() => {
    setMobile(
      /android|iphone|ipad|ipod/iu.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    );
    const platform = detectDownloadPlatform(globalThis.navigator) ?? "macos";
    setDownloadUrl(OPENBOT_DOWNLOAD_LINKS[platform]);
    const cleanup = landingAnalytics.startJoin(document, window.location.hostname, {
      validInvite: invite() !== null,
      platform,
    });
    return cleanup;
  });

  const noApp = () => (mobile() ? props.text.noAppMobile : props.text.noApp);
  const linkHref = (link: JoinLink, browserUrl: string) => (link === "browser" ? browserUrl : downloadUrl());
  // The dialog offers the desktop download, which a phone cannot install. Phones get the note below.
  const armFallback = () => {
    if (!mobile()) fallback.arm();
  };

  return (
    <TransactionalPage titleId="join-title" lang={props.lang}>
      <AppLogo variant="production" animation="blink" class="join-card-logo" />
      <p class="join-card-eyebrow">{props.text.eyebrow}</p>
      <h1 id="join-title">{props.text.title}</h1>
      <p class="join-card-copy">{props.text.intro}</p>

      <Show
        when={invite()}
        fallback={
          <p class="join-card-error" role="alert">
            {props.text.invalid}
          </p>
        }
      >
        {(links) => (
          <>
            <div class="join-card-actions join-card-actions-full">
              <Button href={links().openUrl} variant="primary" size="lg" icon="open" onClick={armFallback}>
                {props.text.open}
              </Button>
            </div>
            <p class="join-card-alternatives">
              <For each={noApp()}>
                {(part) => (
                  <Show when={part.link} fallback={part.text}>
                    {(link) => <a href={linkHref(link(), links().browserUrl)}>{part.text}</a>}
                  </Show>
                )}
              </For>
            </p>
          </>
        )}
      </Show>

      <Show when={mobile()}>
        <p class="join-card-note">{props.text.mobile}</p>
      </Show>
      <p class="join-card-note">{props.text.email}</p>
      <OpenAppFallbackDialog fallback={fallback} text={props.text.openAppFallback} />
    </TransactionalPage>
  );
}
