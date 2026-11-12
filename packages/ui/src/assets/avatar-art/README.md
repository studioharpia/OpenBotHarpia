# Avatar art

Ten body silhouettes and eight pairs of ivory felt eyes approved by Lukas on 10 November 2026.
The generated neutral body atlas was split into transparent, grayscale 256px WebP bodies.
Each eye pair was separated into two transparent 96px WebP pieces. The colour is applied at
render time with Bloub's calibrated tint ramp; eye pieces keep their ivory colour.

`body-cercle`, `body-galet`, `body-squircle`, `body-capsule`, `body-triangle`, `body-hexagone`,
`body-nuage`, `body-carre`, `body-losange` and `body-pentagone` are resized grayscale assets
from `@norbert_bodziony/bloub` 0.6.4 (MIT, see `LICENSE-bloub.txt`). They are needed when new
eye art is combined with a released silhouette. Released combinations continue using the
original library renderer without any changes.

The additive `openbot-art-v1` seed suffix is decoded by the shared desktop/web UI. The original
brand catalogue and its hash inputs remain unchanged, including the mobile renderer. Older
clients render their deterministic legacy fallback for a seed using these additional choices;
the native mobile app does not yet offer the additional art.
