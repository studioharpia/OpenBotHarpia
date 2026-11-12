import type { ExpressionId } from "@norbert_bodziony/bloub";
import {
  type AvatarStyle,
  AVATAR_EXPRESSIONS as LEGACY_EXPRESSIONS,
  SUPPORTED_AVATAR_SILHOUETTES as LEGACY_SHAPES,
  type SupportedAvatarSilhouetteId as LegacyShapeId,
  bloubAvatarProfile as legacyProfile,
  avatarSeedForFace as legacySeedForFace,
  avatarStyleForSeed as legacyStyleForSeed,
} from "@openbot/brand/bloub-avatar";
import type { AvatarColor, AvatarHue } from "@openbot/contracts/ipc";

export const EXTRA_AVATAR_SHAPES = [
  "star",
  "heart",
  "bean",
  "moon",
  "flower",
  "cat",
  "rabbit",
  "ghost",
  "arch",
  "bolt",
] as const;
export const EXTRA_AVATAR_EYES = [
  "hearts",
  "stars",
  "happy",
  "wink",
  "sleepy",
  "curious",
  "focused",
  "spirals",
] as const;
export type ExtraAvatarShape = (typeof EXTRA_AVATAR_SHAPES)[number];
export type ExtraAvatarEyes = (typeof EXTRA_AVATAR_EYES)[number];
export type AvatarShapeId = LegacyShapeId | ExtraAvatarShape;
export type AvatarExpressionId = ExpressionId | ExtraAvatarEyes;
export const AVATAR_SHAPES: readonly AvatarShapeId[] = [...LEGACY_SHAPES, ...EXTRA_AVATAR_SHAPES];
export const AVATAR_EYES: readonly AvatarExpressionId[] = [...LEGACY_EXPRESSIONS, ...EXTRA_AVATAR_EYES];

export function isExtraShape(value: string): value is ExtraAvatarShape {
  return EXTRA_AVATAR_SHAPES.some((id) => id === value);
}
export function isExtraEyes(value: string): value is ExtraAvatarEyes {
  return EXTRA_AVATAR_EYES.some((id) => id === value);
}

/** New choices are explicit. Never append to the arrays hashed by released avatar seeds. */
function savedAppearance(seed: string) {
  const match = /:openbot-art-v1:([^:]+):([^:]+):(plush|flat)$/.exec(seed);
  if (!match) return null;
  const shape = AVATAR_SHAPES.find((id) => id === match[1]);
  const expression = AVATAR_EYES.find((id) => id === match[2]);
  const style: AvatarStyle = match[3] === "flat" ? "flat" : "plush";
  return shape && expression ? { shape, expression, style } : null;
}

export function avatarProfile(seed: string, hue: AvatarHue | null, color: AvatarColor | null = null) {
  const legacy = legacyProfile(seed, hue, color);
  const saved = savedAppearance(seed);
  return { ...legacy, shape: saved?.shape ?? legacy.shape, expression: saved?.expression ?? legacy.expression };
}

export function avatarArtStyle(seed: string): AvatarStyle {
  return savedAppearance(seed)?.style ?? legacyStyleForSeed(seed);
}

export function avatarArtSeed(
  agentId: string,
  face: { shape: AvatarShapeId; expression: AvatarExpressionId },
  style: AvatarStyle = "plush",
): string {
  const { shape, expression } = face;
  if (!isExtraShape(shape) && !isExtraEyes(expression)) return legacySeedForFace(agentId, { shape, expression }, style);
  return `${agentId}:openbot-art-v1:${face.shape}:${face.expression}:${style}`;
}
