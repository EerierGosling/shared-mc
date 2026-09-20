# Motion controls: setup, practice, and tuning

## Choose controls when opening the game

The opening screen offers **Keyboard / mouse / touch**, **Camera gestures**,
**Camera + paired phone steps**, and **Paired phone controller**. Your selection
is remembered in this browser. Join the game normally; motion selections open
setup in **practice mode**, without requesting camera permission until you press
**Start Camera**. You can reopen setup from **Game menu → Motion Controls**.

Practice mode displays detected actions without sending them to the player.
Press **Enable Player Control** when ready. **Return to Practice** releases all
motion actions; **Stop All Inputs** also stops the camera and motion sensor and
revokes a desktop pairing. Done closes the panel and keeps enabled controls running.
Keyboard/touch input remains available alongside motion controls.

## Camera-only setup

1. Use HTTPS (or localhost on the same computer). Place a stable camera around
   chest/face height. Fit your face, hips, hands, and feet in the picture with
   room above your head. Prefer even front lighting and a simple background.
2. Select front/default or rear camera, then press **Start Camera**. Changing
   cameras stops capture; start it again to use the new choice.
3. Stand still in a comfortable neutral stance and look straight ahead while
   calibration completes. It takes about 30 stable tracked frames. Keep feet
   visible during calibration if you want physical jumping.
4. Check the green landmark overlay and the **Head / Mining arm / Legs** status.
   Head steering and mining can work with just your upper body visible. Walking
   needs hips and legs. Physical jumps require feet visible during calibration;
   if you calibrated seated, recalibrate after standing in full view.
5. Test the movements below in practice mode. Recalibrate after moving the
   camera, changing your distance, or switching between sitting and standing.
6. Enable player control. Press Escape / Menu to suspend input, or return to
   practice to make adjustments.

| Movement | Action | How it stops |
|---|---|---|
| Head lean/displacement left or right | Pan left/right | Return to neutral |
| Head movement up or down | Look up/down | Return to neutral |
| Right-arm swing or forward punch (left selectable) | Mine the crosshair target | Stop swinging; default hold is 800 ms |
| Alternating knee lifts | Walk forward | Stop stepping; default delay is 650 ms |
| Forward movement with autojump enabled | Repeated jumps while moving | Stop forward movement or disable autojump |
| Both feet and hips rising together | Jump from standing | Brief jump pulse, with a cooldown |
| Smile, optional | Use/place once | Relax before the next smile |
| Open mouth, optional | Hold jump | Relax your mouth |

Autojump currently holds the jump control while walking; it is continuous
hopping, not obstacle-aware pathfinding. It also rises while creative flight is
active. Disable autojump if you want to steer flight without ascending.

Facial actions are opt-in, use an additional face model, and require the
expression to cross its threshold for roughly 250 ms. Talking and smiling can
trigger these actions, so test them before enabling control. The face must be
large enough in the image; a full-body view may be too distant for reliable
expressions on some cameras.

## Pair a phone with QR code

1. Open **Pair a Phone** on the game screen, after joining.
2. Check **Site address reachable from your phone**. It must point to this same
   running application. A desktop URL such as `localhost:3000` points to the
   phone itself when opened on a phone. Use a reachable HTTPS deployment or
   an HTTPS reverse proxy/tunnel to your development server. Plain HTTP LAN
   addresses generally cannot access camera/motion sensors.
3. Press **Generate Code**. Scan the QR code using the phone camera, or
   open the displayed link on the phone. The code is already filled in when
   opening the QR/link. Alternatively, open `/controller` and enter the code.
4. Press **Connect to game** on the phone. Codes expire after five minutes and
   work once. Once connected, the QR/code is removed from the game screen.
5. Choose inputs and practice on the phone, then enable player control on
   **both** screens. No extra Minecraft player is created.
6. Keep the phone page visible and the screen awake. A wake-lock request is
   made where supported, but operating systems can still suspend a browser.
   Disconnect, sleep, or stale updates release phone input. Reconnection after
   a socket disconnect requires a new code.

Recommended hybrid setup: mount the computer camera for head/arm/body input;
use the phone for accelerometer steps while carrying it securely. On the phone,
turn on **Phone Steps** (no camera required), allow motion permission if
prompted, practice, and enable control. The live measurements show acceleration
and warn if no samples arrive. Step recognition requires repeated peaks, not a
single shake. There is a gravity-filter fallback for devices that only report
acceleration including gravity.

Alternatively, mount the phone to use its camera as the sole tracker and leave
accelerometer steps off. A phone moving with your body is a poor stationary
camera: do not expect simultaneous handheld full-body camera tracking and
accelerometer walking to be reliable.

The desktop merges camera and phone actions. Either source can hold forward,
jump, or mining; releasing one source does not cancel the other. Head look from
both sources adds together, so normally use just one camera for steering.
The receiving game browser's look-speed slider controls final turn speed.

## Tune sensitivity

Settings save independently in each browser. Tune camera settings on the device
running that camera and phone thresholds on the phone. Changes return that
device to practice mode. A preset is a starting point; selecting one resets the
settings to that preset. **Reset sensitivity** restores the defaults.

| Symptom | Adjustment |
|---|---|
| View drifts while standing still | Recalibrate, then increase **Head dead zone** |
| Head movement does not turn enough | Lower dead zone, then increase **Look speed** |
| View turns too far | Reduce **Look speed** |
| View jitters | Improve lighting; increase **Head smoothing** |
| Steering feels delayed | Reduce smoothing; disable facial actions if tracking is slow |
| Left/right or up/down feels reversed | Toggle the corresponding **Invert** option |
| Small steps are missed | Lower **Knee lift threshold** or use Small movements preset |
| Standing posture triggers walking | Raise knee threshold; check full leg visibility |
| Walking stops between steps | Increase **Walking stop delay** slightly |
| Walking continues too long after stopping | Reduce walking stop delay |
| Arm swings are missed | Lower **Arm speed threshold**; select the correct arm |
| Casual hand motion mines blocks | Raise arm speed threshold |
| Mining harder blocks keeps restarting | Keep swinging or increase **Mining hold** |
| Physical jump is missed | Show feet during calibration, recalibrate, then lower jump threshold |
| A small bounce triggers jump | Increase **Jump height threshold** |
| Phone steps are missed | Check live sensor readings, then lower **Phone step threshold** |
| Phone handling triggers walking | Raise phone threshold and carry it in a steadier position |
| Expression triggers accidentally | Raise **Smile / mouth threshold**, or disable facial actions |
| Lost tracking | Improve framing/light; sensitivity cannot recover invisible landmarks |

Lower thresholds mean easier activation, not faster movement. Look speed changes
turn rate; Minecraft still controls movement speed. Higher smoothing filters
more jitter at the cost of response time. Body thresholds are normalized by
shoulder width (head/arm) or torso size (legs/jumps), phone thresholds are in m/s², and expression scores range from 0 to 1.

## A repeatable practice routine

1. Calibrate neutral with your usual stance and camera position.
2. Open **Live measurements**. Stand still for ten seconds; aim for no detected
   walking, jumping, mining, or use actions.
3. Try each gesture ten times, one at a time. Count detections and misses.
4. Compare the relevant live reading to its threshold. Set the threshold above
   ordinary incidental movement and below your deliberate movement.
5. Change only one slider at a time. Repeat the stationary and ten-gesture tests.
6. Test combinations: steer while stepping, mine while standing, then walk and
   stop. Verify stopping and leaving the camera frame release actions.
7. Enable control in a place where you can comfortably test movement and mining.
   Revisit practice if your position, camera, lighting, or clothing changes.

The overlay shows landmarks the pose model considers visible; it does not prove
that an action was recognized correctly. If a body part disappears in the
preview, fix framing/lighting before reducing thresholds. A brief tracking gap
clears partially detected movements. Mining requires at least two consecutive
movement samples and meaningful displacement, which rejects a single noisy wrist
reading. Expression activation requires a continuous dwell above the threshold.

This personalizes a **pretrained** landmark detector with calibration and
thresholds; it does not retrain MediaPipe. The application does not record or
upload videos, landmarks, or a training dataset. If you want a learned custom
gesture classifier later, that is a separate model-development task: collect
labeled movement and non-movement examples across people/sessions, split by
person/session before evaluating, and tune for both missed gestures and false
activations. Do not confuse success on the calibration samples with performance
on unseen movements. The current practice measurements are for tuning the
existing recognizer, not for fitting a new model.

## Privacy, runtime, and verification

Pose and optional face inference run in the browser. Pinned MediaPipe JS/WASM
and models download from jsDelivr and Google when enabled. QR generation is local;
no external QR service receives the link. Pairing relays only bounded action
states to the owning game browser, using a random single-use code, packet rate
limits, and a 500 ms server timeout (plus a receiver freshness check).

Camera inference currently runs at a limited cadence on the browser thread.
**Live measurements** reports inference duration. On slower devices, turn off
facial actions or use desktop camera tracking with phone accelerometer input.
The code handles permission failures, cancellation, missing landmarks, blocked
model downloads, and camera disconnects; browser and physical-device behavior
still varies.

Run `npm test` for gesture, expression, motion-sensor, settings, and pairing tests;
run `npm run build` for all production bundles. Physical gesture accuracy and
phone permissions should be checked on your actual camera/phone using the
practice routine above.

API references: [MediaPipe pose tracking](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js),
[MediaPipe facial blendshapes](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js),
and [browser motion permissions](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static).

An optional browser integration check lives in `test/motion-browser.cjs`. It
requires Chrome and `playwright-core` in your development environment (or its
module path in `PLAYWRIGHT_MODULE`). Run `node test/motion-browser.cjs` after
building; it uses a fake game session and synthetic input without connecting to
Minecraft. Set `LIVE_MEDIAPIPE=1` to also verify real model downloads and
initialization against Chrome's synthetic camera. Screenshots go to `/private/tmp`.
