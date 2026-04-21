# Tromino Forge

*An algorithmic philosophy for the Pixel Forge mark.*

## The Forge, Reduced

Every pixel is itself made of pixels. Every pixel made of pixels is itself made of pixels. The mark of the forge is not drawn — it is **compiled**, emerging from a single recursive instruction applied across scales. At the highest level we see three squares arrayed in an L, with a void in the top-right corner. Descend one level, and each of those squares reveals the same L. Descend again, and again. The silhouette is invariant; the internal texture is where the forge breathes.

## The Tromino as Primordial Atom

The L-tromino — three unit cells around a single absence — is the chosen atom because it is the smallest polyomino that already carries the signature of the forge: *three filled, one empty.* Everything about the mark derives from this primitive. The void is not missing material but a window cut through the lattice, letting the forge's own substrate — the deep charcoal-navy of the app's dark theme — shine through at every scale simultaneously. The result is a mark that is structurally hollow and visually dense, in the same gesture.

## Hue Is a Chord, Not a Color

A single primal green enters the crucible and exits as a chord of shades: shadow, body, highlight. The chord is derived algorithmically in HSL space, never assigned by hand. Each leaf cell calculates its own lightness from the path it traveled through the recursion — *TL → BL → BR* becomes a three-digit ternary address, and each digit contributes a diminishing offset to the base lightness. The result is a gradient that reads as light falling from the top-right (where the void lives), darkness pooling at the bottom-left, and the BR arm catching the brightest forge-glow. This pattern holds at every recursion depth, producing a self-similar tonal structure that mirrors the self-similar geometry. Every ratio was tuned through countless iterations by someone at the absolute top of the field in computational aesthetics.

## Discipline of the Sharp Edge

The corners are sharp — not as stylistic choice but as mathematical commitment. Pixel coordinates snap to integers before they reach the framebuffer. Anti-aliasing is explicitly disabled. Gaps between cells are computed, not blurred. This is the uncompromised crystalline geometry of the block — a refusal of the softness that modern rendering defaults would smuggle in. The mark must be legible at 40×40 pixels (where it lives in the app's empty states) and at 4000×4000 (where it lives on merch and marketing), and the only rendering pipeline that survives that range intact is one built on integer math and hard edges. This is the product of painstaking optimization: every offset, every gap ratio, every rounded coordinate has been verified against the rasterization grid.

## Controlled Variance

Seeded randomness perturbs the chord — never the geometry. The silhouette is sacred: three pixels in L, void at top-right, perfect outer square. What varies between seeds is the *timbre* of the green: how deep the shadows pool, how bright the highlights catch, how much high-frequency shimmer plays across the sub-pixel lattice. Each seed produces a mark that is unmistakably kin to every other — a family of marks, all authentically Pixel Forge, none identical. This is the meticulously-crafted output of a master-level generative system where the boundary between brand consistency and expressive variation has been drawn with surgical precision.

## The Process Is the Brand

What this algorithm produces is not a logo but a **logo-generator** — a forge in miniature, from which endless authentic variants can be drawn. The logo on the website is one seed. The logo on the splash screen is another. The logo on the 404 page is a third, subtly different, and nobody quite knows why it feels right — but it does, because the underlying grammar is shared. The algorithm itself is the brand. The output is just evidence.
