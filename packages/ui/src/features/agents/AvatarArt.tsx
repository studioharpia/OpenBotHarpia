import { BloubBot, type BloubBotProps, type BotLayerContext, type RenderedEye } from "@norbert_bodziony/bloub";
import { PlushBot, type PlushBotProps, tintRamp } from "@norbert_bodziony/bloub/plush";
import { createMemo, For, Show } from "solid-js";
import { type AvatarExpressionId, type AvatarShapeId, isExtraEyes, isExtraShape } from "../../avatar-catalog";

// These pieces are inline so exported/composer SVGs also work inside data: images (no external URLs).
const assets = import.meta.glob<string>("../../assets/avatar-art/*.webp", {
  eager: true,
  query: "?inline",
  import: "default",
});

function asset(name: string): string {
  const url = assets[`../../assets/avatar-art/${name}.webp`];
  if (!url) throw new Error(`Missing avatar art: ${name}`);
  return url;
}

type ArtProps = { shape: AvatarShapeId; expression: AvatarExpressionId };
type PlushProps = Omit<PlushBotProps, "shape" | "expression"> & ArtProps;
type FlatProps = Omit<BloubBotProps, "shape" | "expression"> & ArtProps;

const colourTables = new Map<string, string[]>();
function colourTable(hex: string): string[] {
  const cached = colourTables.get(hex);
  if (cached) return cached;
  const ramp = tintRamp(hex);
  // Sixteen samples preserve Bloub's calibrated curve without rebuilding 768 numbers per avatar.
  const tables = [0, 1, 2].map((channel) =>
    Array.from({ length: 16 }, (_, index) => ((ramp[index * 17 * 3 + channel] ?? 0) / 255).toFixed(5)).join(" "),
  );
  colourTables.set(hex, tables);
  return tables;
}

/** The usable face of each silhouette, in the engine's 316-unit viewBox. */
const FACE_AREAS = {
  star: { x: 0, y: 0, w: 90, h: 58 },
  heart: { x: 0, y: -4, w: 90, h: 55 },
  bean: { x: -5, y: 4, w: 76, h: 62 },
  moon: { x: -45, y: 0, w: 47, h: 60 },
  flower: { x: 0, y: 0, w: 86, h: 58 },
  cat: { x: 0, y: 18, w: 90, h: 58 },
  rabbit: { x: 0, y: 44, w: 76, h: 48 },
  ghost: { x: 0, y: 0, w: 90, h: 58 },
  arch: { x: 0, y: -48, w: 68, h: 32 },
  bolt: { x: 0, y: 0, w: 58, h: 46 },
} as const;

export function AvatarPlush(props: PlushProps) {
  const extended = () => isExtraShape(props.shape) || isExtraEyes(props.expression);
  const nativeShape = () => (isExtraShape(props.shape) ? "cercle" : props.shape);
  const nativeExpression = () => (isExtraEyes(props.expression) ? "neutre" : props.expression);
  const state = () => {
    if (props.state === "asleep") return "sleep";
    if (props.state === "failed" || props.state === "thinking") return "idle";
    return props.state ?? "idle";
  };
  return (
    <Show when={extended()} fallback={<PlushBot {...props} shape={nativeShape()} expression={nativeExpression()} />}>
      <BloubBot
        {...props}
        shape={nativeShape()}
        expression={props.state === "failed" ? "triste" : nativeExpression()}
        state={state()}
        layer={(context) => <AvatarArtLayer context={context} {...props} flat={false} />}
      />
    </Show>
  );
}

export function AvatarFlat(props: FlatProps) {
  const extended = () => isExtraShape(props.shape) || isExtraEyes(props.expression);
  const nativeShape = () => (isExtraShape(props.shape) ? "cercle" : props.shape);
  const nativeExpression = () => (isExtraEyes(props.expression) ? "neutre" : props.expression);
  return (
    <Show when={extended()} fallback={<BloubBot {...props} shape={nativeShape()} expression={nativeExpression()} />}>
      <BloubBot
        {...props}
        shape={nativeShape()}
        expression={nativeExpression()}
        layer={(context) => <AvatarArtLayer context={context} {...props} flat />}
      />
    </Show>
  );
}

function AvatarArtLayer(props: ArtProps & { context: BotLayerContext; flat: boolean; eyeScale?: number }) {
  const frame = () => props.context.frame();
  const body = () => asset(`body-${props.shape}`);
  const size = () => (isExtraShape(props.shape) ? 216 : 316);
  const filterId = `${props.context.uid}-art-tint`;
  const maskId = `${props.context.uid}-art-body`;
  const tables = createMemo(() => colourTable(props.context.ink()));
  const faceOffset = createMemo(() => {
    const area = isExtraShape(props.shape) ? FACE_AREAS[props.shape] : { x: 0, y: 0, w: 90, h: 58 };
    const imageEyes = isExtraEyes(props.expression);
    const growth = props.eyeScale ?? 1;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const eye of frame().eyes) {
      const [a = 1, b = 0, c = 0, d = 1, x = 0, y = 0] = (eye.matrix.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
      const halfW = (imageEyes ? 17 : eye.w / 2) * growth;
      const halfH = (imageEyes ? 17 : eye.h / 2) * growth;
      const width = Math.abs(a) * halfW + Math.abs(c) * halfH;
      const height = Math.abs(b) * halfW + Math.abs(d) * halfH;
      left = Math.min(left, x - width);
      right = Math.max(right, x + width);
      top = Math.min(top, y - height);
      bottom = Math.max(bottom, y + height);
    }
    if (!Number.isFinite(left)) return undefined;
    const scale = Math.min(1, area.w / Math.max(1, right - left), area.h / Math.max(1, bottom - top));
    return `translate(${area.x},${area.y}) scale(${scale}) translate(${-(left + right) / 2},${-(top + bottom) / 2})`;
  });
  return (
    <g data-avatar-art={props.shape}>
      <defs>
        <filter id={filterId} color-interpolation-filters="sRGB">
          <feComponentTransfer>
            <feFuncR type="table" tableValues={tables()[0]} />
            <feFuncG type="table" tableValues={tables()[1]} />
            <feFuncB type="table" tableValues={tables()[2]} />
          </feComponentTransfer>
        </filter>
        <mask id={maskId} mask-type="alpha" x={-158} y={-158} width={316} height={316} maskUnits="userSpaceOnUse">
          <image href={body()} x={-size() / 2} y={-size() / 2} width={size()} height={size()} />
        </mask>
      </defs>
      <Show
        when={props.flat}
        fallback={
          <image
            href={body()}
            x={-size() / 2}
            y={-size() / 2}
            width={size()}
            height={size()}
            filter={`url(#${filterId})`}
          />
        }
      >
        <rect x={-158} y={-158} width={316} height={316} fill={props.context.ink()} mask={`url(#${maskId})`} />
      </Show>
      <g transform={faceOffset()}>
        <For each={frame().eyes}>
          {(eye, index) => (
            <g transform={eye.matrix} opacity={eye.alpha}>
              <g transform={`scale(${props.eyeScale ?? 1})`}>
                <Show when={isExtraEyes(props.expression)} fallback={<path d={eye.d} fill="#f4eddd" />}>
                  <ArtEye
                    eye={eye}
                    expression={props.expression}
                    side={index()}
                    flat={props.flat}
                    uid={props.context.uid}
                  />
                </Show>
              </g>
            </g>
          )}
        </For>
      </g>
      <For each={frame().dots}>
        {(dot) => (
          <circle cx={dot.x * 100} cy={dot.y * 100} r={dot.r * 100} fill={props.context.ink()} opacity={dot.opacity} />
        )}
      </For>
      <Show when={frame().notif}>
        {(dot) => <circle cx={dot().x * 100} cy={dot().y * 100} r={dot().r * 100} fill={props.context.ink()} />}
      </Show>
    </g>
  );
}

function ArtEye(props: { eye: RenderedEye; expression: AvatarExpressionId; side: number; flat: boolean; uid: string }) {
  const url = () => asset(`eye-${props.expression}-${props.side}`);
  const id = `${props.uid}-art-eye-${props.side}`;
  // The image owns its silhouette; the engine still owns gaze, blinking, hover and pause.
  return (
    <Show when={props.flat} fallback={<image href={url()} x={-17} y={-17} width={34} height={34} />}>
      <defs>
        <mask id={id} mask-type="alpha" maskUnits="userSpaceOnUse" x={-20} y={-20} width={40} height={40}>
          <image href={url()} x={-17} y={-17} width={34} height={34} />
        </mask>
      </defs>
      <rect x={-20} y={-20} width={40} height={40} fill="#f4eddd" mask={`url(#${id})`} />
    </Show>
  );
}
