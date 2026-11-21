---
status: approved
---

# Design brief: Circle Check+

## The one spatial moment
Stand 100 cm in front of a 1:1 scale luminous SUV front cab and crouch to 70 cm toddler height (`Q/E`): the live green sightline beam between your eyes and the driver's eyes snaps against the hood ridge with a red hit marker, proving sightline reciprocity with your own body. Then step into the driver seat to hit `Ready to Depart` (blocked), walk around the front (`WASD`) sweeping SPECS's `37° × 32°` view to flip all 3 blind-spot zones green, pinch-drag the hidden 50 cm child tricycle out of the forward lane into the side Safe Parking Ring, and return to the driver seat to depart safely.

## Why it belongs on glasses
- Uses: shares your view, draws in the world, leaves your body free.
- Why it's better than the phone or laptop version: A flat 2D overhead diagram tells you blind spots exist, but a 1:1 world-anchored vehicle front in your room lets your actual eye height (`160 cm` standing vs `70 cm` crouched) and footsteps (`WASD` walkaround) prove why a driver cannot see a toddler ahead of the hood and force physical inspection before departure.

## Product or overlay
- Type: product: the virtual 1:1 SUV front cab, blind-spot floor zones, sightline beam, and hidden child tricycle are the experience.
- What the real version would sense: Nothing (self-contained 1:1 spatial safety trainer in the user's room; does not recognize or track real vehicles or people).
- Stand-in for the preview: None needed for sensing. In Interactive Preview (`SPECS 27`), `WASD` + `Q/E` + mouse pinch drive real-time walkaround and single-hand drag; for automated LEAF tests (where `DeviceTracking` may lock the Preview camera), the scene feeds the exact same local-space `camLocalPos` pipeline via camera pose or `VehicleRoot` relative offset with zero bypass flags.

## Where things live
- Where the user is looking during the main task: Ahead at the 1:1 vehicle front bumper/hood, down at the 3 front floor blind-spot zones (`x ∈ [-180, +180] cm`, `z ∈ [-40, +320] cm`), and slightly below horizontal forward gaze when seated in the cab.
- 1:1 Vehicle Front Occluders (`VehicleRoot`, floor at `localY = 0`): Front bumper (`200 cm` wide, `y = 0..112 cm`, `z = 0`), sloped hood rising from `(y = 112, z = 0)` to `(y = 118, z = -150 cm)`, left/right A-pillars (`y = 118..172 cm`, `z = -150..-185 cm`), driver eye marker at `(-45, 152, -195 cm)`. Rendered with `DepthWrite: true` plus bright luminous wireframe borders for additive optics.
- Live Sightline Beam: Connects `(-45, 152, -195 cm)` to the active camera eye pose whenever outside the cab — bright green end-to-end when clear, truncated at the exact first occluder hit with a bright red hit marker when blocked.
- 3 Static Floor Blind-Spot Zone Meshes (`FrontLeftAPillar`, `FrontCenterHood`, `FrontRightAPillar`): `18 × 18` grid (`20 cm` cells, `< 1,500` total vertices) evaluated once at boot for fixed `70 cm` toddler height, switching from bright orange-red (uninspected) to bright cyan-green (verified) once `>= 60%` of a zone is swept by the unoccluded forward `-Z` `37° × 32°` frustum.
- Low Cabin Dashboard Strip: World-anchored inside the cab at `(-45, 136, -152 cm)` (strictly behind hood trailing edge `z = -150 cm`, `~20.4°` below horizontal forward gaze), holding `Ready to Depart` and `Reset`.
- 3 Walkaround Checkpoint Beacons: `110 cm` tall luminous vertical columns world-anchored at each unchecked zone's front/side vantage point.
- Hidden Child Tricycle & Safe Parking Ring: `50 cm` tall luminous tricycle starting at `(+15, 0, +55 cm)` inside the forward danger lane (`x ∈ [-115, +115]`, `z ∈ [0, +300] cm`); glowing cyan Safe Parking Ring at `(+150, 0, +70 cm)` (`radius = 25 cm`).

## Hands and input
- `Ready to Depart` and `Reset`: Pinch / click UI buttons on the low cabin dashboard strip when seated inside the driver-seat threshold (`horizontalDistXZ <= 45 cm`, `|Δy| <= 35 cm`).
- Clear Hidden Child Tricycle: Single-hand pinch-drag locked to `localY = 0` (`useFilter = false`, rotation/scale off, clamped outside bumper/cab keepout `[-105, +105] × [-220, +5] cm`). Guarded by reach (`<= 150 cm` XZ) and unoccluded line-of-sight so grabbing through the hood from the driver seat fails closed (`OUT_OF_REACH` / `OCCLUDED_BY_VEHICLE`). Valid release past `x > +85 cm` or within `65 cm` of `(+150, +70 cm)` snaps cleanly into the Safe Parking Ring.
- Targets are big and highlight when aimed at.
- Voice (if any) and the button that does the same job: None (all actions use spatial head/body movement + big UI/drag targets).

## When things show
- Low Cabin Dashboard Strip (`Ready to Depart`, `Reset`): Shows when inside the driver seat (`<= 45 cm` XZ and `|Δy| <= 35 cm` of driver eye); hides during exterior walkaround so the front view stays uncluttered.
- Live Sightline Beam: Shows when outside the driver seat; hides when seated inside the driver eye position.
- 3 Walkaround Checkpoint Beacons: Illuminate when `Ready to Depart` blocks departure (and while outside the cab for any unchecked zone); each beacon hides once its zone flips cyan-green.
- If something needs attention out of view: Procedural spatial audio feedback cues (blocked chime, zone-verified chime, tricycle snap chime, departure cleared fanfare) + tall `110 cm` luminous checkpoint beacons at unchecked zones.

## Done criteria
Each one can be checked in Lens Studio's preview.
1. **Sightline Reciprocity**: Standing `100 cm` ahead of the front bumper (`x = -45, z = +100 cm`) at `160 cm` eye height renders an unoccluded bright green sightline beam (`sightlineBlocked === false`); crouching to `70 cm` toddler height truncates the beam at the hood ridge (`y ≈ 91.5 cm` grazing height) with a red hit marker (`sightlineBlocked === true`).
2. **Blocked Departure & Through-Hood Drag Guard**: Entering the driver seat shows the low cabin dashboard unoccluded by the hood; pressing `Ready to Depart` before inspection sets `departureStatus === "BLOCKED"` and illuminates all 3 unchecked checkpoint beacons; attempting to drag the tricycle through the hood from the driver seat fails closed (`isTricycleCleared === false`, position unchanged, `lastRejectReason` non-null).
3. **3-Zone Walkaround Frustum Flip, Tricycle Clearance & Cleared Departure**: Walking around the vehicle front to sweep all 3 blind-spot zones via unoccluded forward `-Z` `37° × 32°` frustum (`>= 60%` per zone) flips all 3 floor meshes cyan-green (`allZonesVerified === true`), close-range unoccluded single-hand drag snaps the tricycle into the `(+150, +70)` Safe Parking Ring (`isTricycleCleared === true`), returning to the driver seat and pressing `Ready to Depart` transitions `departureStatus` to `"CLEARED"`, and `Reset` restores clean initial state.

## Out of scope
- Right-turn inner-wheel-difference (`tractrix`) swept-path simulation or moving vehicle driving physics.
- Adjustable planar or convex mirrors and mirror-reflected amber tiles.
- Cockpit multi-height preset switcher (`70 / 100 / 170 cm`) — adult vs toddler comparison is shown physically by standing (`160 cm`) vs crouching (`70 cm`).
- Live camera vehicle detection (SnapML), two-hand gestures, voice-only controls, or multi-user networking.
- Live human on-camera narration or voiceover in the demo video.

## Risks and open questions
- **Logic proven vs feel unproven**: All spatial math, sightline reciprocity, frustum zone-flip, through-hood drag rejection, and departure state transitions are verified offline (`Vitest + fast-check` PBT) and in Lens Studio Interactive Preview + `LEAF` (`logic proven`). Physical SPECS waveguide brightness, real-world crouch comfort, and optical hand-tracking ergonomics remain `feel unproven` without physical SPECS hardware and will be explicitly labeled in `README.md`.
- **Toolchain probe**: Ticket 01 probes `Lens Studio 5.25.0 + ls-clad v1.1.0 (InteractionKit / UIKit v4.0 + Leaf)` first and falls back atomically to `Lens Studio 5.23.2 + ls-clad v1.0.0 + SIK v2.0.0` if Snap developer sign-in blocks CLAD.

## Build notes for CLAD
- Build for SPECS so it runs and can be demonstrated in Lens Studio's preview. No SPECS device is available.
- Use Spectacles Interaction Kit (SIK) / InteractionKit and UI Kit for all interactions, so they work with the mouse in Interactive Preview and with LEAF.
- Build any stand-in exactly as described above, and keep it obvious in the scene.
- Use real-world scale in centimeters. Keep content inside the user's view during the main task.
- The display is additive: black renders as transparent. Don't rely on black or very dark content to be seen; keep text light and readable from where the user stands.
- Get the basic flow working first, then add detail.
- Write LEAF scenarios for each done criterion, run them in preview, and report which pass. Say which criteria have no test.
- Don't record, identify, or follow people.

## After the build: judge it
This part is for you, after CLAD finishes.

1. **Does it work?** Ask your agent which LEAF tests passed and which done criteria have no test.
2. **Walk around it.** Open the preview in Interactive Preview. Use WASD to move, Q and E to go down and up, and right-drag (or hold Shift) to look around. Clicking acts as a pinch. Stand where a user would and look at the task.
3. **Ask the three questions.**
   - Does it use what I'm looking at?
   - Does it put something in my space, where it belongs?
   - Does it free my hands or let me keep my eyes up?
   - Would it be just as good on a phone? If so, what would make it need the glasses?
4. **Check comfort.**
   - Everything I need is in view while I do the task. Nothing sits at the edges, behind me, or stuck to my face.
   - Every control is within reach of someone standing there.
   - Text reads easily from where I stand. No dark UI disappearing.
   - Things show when needed and get out of the way.
5. **Label what you know.** Write "logic proven" next to anything the tests and preview show working, and "feel unproven" next to anything only real glasses could tell you (comfort over time, real hand tracking, real recognition).
6. **Fix with design notes, not code.** Tell your agent what to change in design terms, for example: "Move the step card 15 cm lower and next to the pan. Make the Next button twice as big. Re-run the tests." If a fix takes under a minute, like nudging a panel, do it yourself in the scene.
7. **Submit.** Record a video under 3 minutes of your Lens in the preview, public on YouTube. Make your repo public with your Lens Studio project and this `devpost/` folder. Details are on the hackathon site: https://learn-specs.devpost.com/resources
