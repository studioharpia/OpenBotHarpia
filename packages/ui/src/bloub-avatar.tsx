import type { AvatarColor, AvatarHue } from "@openbot/contracts/ipc";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { avatarProfile as bloubAvatarProfile } from "./avatar-catalog";
import { AvatarFlat } from "./features/agents/AvatarArt";

/**
 * When an avatar animates, which is a performance decision and not a state one: `hover` and `idle`
 * rest until a pointer or focus reaches them, `always` runs. What the avatar *expresses* is its
 * `AvatarMood` - see `@openbot/brand/bloub-avatar-motion`.
 */
export type AvatarMotion = "hover" | "always" | "idle";
export {
  AVATAR_COLOR_CHOICES,
  AVATAR_HUE_CHOICES,
  AVATAR_STYLES,
  type AvatarColorChoice,
  type AvatarStyle,
  avatarDefaultSeed,
  avatarHeadColor,
  avatarHueForColor,
  avatarHueSwatch,
  type BloubAvatarProfile,
  isAvatarColorChoice,
} from "@openbot/brand/bloub-avatar";
export {
  type AvatarMood,
  avatarMoodIsBusy,
  avatarMoodPresentation,
  SHAPE_SAFE_STATES,
  type ShapeSafeStateId,
} from "@openbot/brand/bloub-avatar-motion";
export {
  AVATAR_EYES as AVATAR_EXPRESSIONS,
  AVATAR_SHAPES as SUPPORTED_AVATAR_SILHOUETTES,
  type AvatarExpressionId,
  type AvatarShapeId as SupportedAvatarSilhouetteId,
  avatarArtSeed as avatarSeedForFace,
  avatarArtStyle as avatarStyleForSeed,
  avatarProfile as bloubAvatarProfile,
} from "./avatar-catalog";

export function createStaticAvatarSvg(
  seed: string,
  hue: AvatarHue | null,
  color: AvatarColor | null = null,
): SVGSVGElement {
  const host = document.createElement("span");
  const dispose = mountStaticAvatar(host, seed, hue, color);
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  const result = svg.cloneNode(true);
  if (!(result instanceof SVGSVGElement)) {
    dispose();
    throw new Error("Bloub did not clone an SVG avatar.");
  }
  dispose();
  return result;
}

function mountStaticAvatar(
  host: HTMLElement,
  seed: string,
  hue: AvatarHue | null,
  color: AvatarColor | null,
): () => void {
  const profile = bloubAvatarProfile(seed, hue, color);
  const dispose = render(
    () => (
      <AvatarFlat
        size={100}
        shape={profile.shape}
        color={profile.color}
        expression={profile.expression}
        frozenAt={0}
        ariaLabel=""
      />
    ),
    host,
  );
  flush();
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  svg.removeAttribute("role");
  svg.removeAttribute("aria-label");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return dispose;
}
