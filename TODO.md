# Follow-up Items

Track these as GitHub issues once the repo is set up.

## Must Have (before first real use)
- [ ] Stream clip exports via `sendStream()` instead of buffering to memory (OOM risk for clips >5min)
- [ ] Test against real Scrypted instance with NVR plugin installed
- [ ] Verify `ScryptedInterface.VideoRecorder` constant matches actual runtime string

## Should Have
- [ ] MixinProvider implementation (Option C) — intercept `takePicture()` to add recording fallback when live stream fails, transparently fixing the go2rtc pipeline for all consumers including LLMVision
- [ ] E2E test script that hits endpoints against a real Scrypted instance
- [ ] Explore `VideoFrameGenerator` for multi-frame extraction endpoint (`/frames/:deviceId`)

## Nice to Have
- [ ] Audio clip support — if AST audio classifier events have associated recordings, expose `/audio/clip/:deviceId` endpoint using same pattern
- [ ] Plugin settings for: default resize dimensions, allowed device IDs, max clip duration
- [ ] Publish to npm as installable Scrypted plugin
- [ ] Upstream contribution to Scrypted ecosystem (list as community plugin)
- [ ] Browser-based test UI (simple HTML page that discovers devices and shows snapshots)
