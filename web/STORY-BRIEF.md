# Story page brief

Self-authored under explicit creative delegation. The user set the story (problem first, then the solution), asked for drawings over text, no navigation bars, an original palette and layered motion, and left the design decisions to us. Method follows the scroll-craft skill (beats, feeling curve, one peak, device score, taste rules). Built with GSAP ScrollTrigger and Lenis instead of the skill's own engine. Art is hand-drawn SVG instead of generated video.

**Vibe:** loud to hushed to clear. Editorial flat illustration, like a short animated film with almost no dialogue.

**It's the site where** you scroll and a mouth speaks the words.

## Feeling curve

| Act | Beat | Feeling | Device | Ground |
|---|---|---|---|---|
| 1 Noise | Recognition | Overwhelmed | pin + parallax (4 planes) + scrubbed noise | Vermilion |
| 2 Silence | Tension | Hushed, lonely | flowing reveal + parallax, no pin | Fog blue |
| 3 Focus | Turn (peak) | Relief, clarity | pin + iris reveal + signature move | Ink |
| 4 How | Substance | Confident | horizontal pan with depth | Paper |
| 5 Close | Commitment | Invited | flow-in + magnetic button | Paper |

**Peak:** the noise lines from act 1 untangle into one clean line, and as you scroll, a caption types along it while the mouth shapes each letter.

**Signature move:** scroll-driven speech. The scroll position decides how many letters are typed, and the mouth takes the shape of the current letter, so scrolling back un-says the sentence.

## Palette (six tokens)

| Token | Hex | Role |
|---|---|---|
| ink | `#17161c` | Text, figures, the focus act ground |
| paper | `#f4f3ef` | Light ground, speech bubbles |
| vermilion | `#ff5b3a` | Noise act ground: loud |
| fog | `#cfdbe8` | Silence act ground: quiet |
| butter | `#ffd447` | The clean caption line, focus frames |
| lip | `#c2392e` | Brand accent, shared with the product page |

Type: Archivo (wide cut) for the few display words, Geist for small text and buttons.

## Text budget

Seven short lines in total: the bubble, one line in act 2, the typed caption, one claim, three one-word panels, and the closing line plus buttons.

## Transitions between acts

Each act hands off to the next instead of cutting:

- Noise to silence: fog spreads out in a circle from where the speech bubble was, and swallows the street.
- Silence to focus: the act arrives in the same fog, then ink opens from the centre, with the noise inside it.
- Focus to how: paper opens outward from the caption line.
- How to close: the close slides up over the panels like a sheet while they sink back.

## Exits to the demo

- Hero: a small "Skip to the demo" link, top right, gone once you scroll.
- Close: "Try the live demo".
- The demo's top bar has "Back to the story".
