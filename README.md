# G-code Print Simulator

Preview a 3D print in your browser and export it as a time-lapse MP4. The simulator is a single HTML file, so there is nothing to install, and your G-code never leaves your computer.

## Quick start

1. Open `gcode-print-simulator.html` in a current version of Edge or Chrome.
2. Drop a `.gcode` file onto the page, or click **Open G-code**. To try it without a file of your own, use `sample-mk3s.gcode`.
3. Adjust the printer, filament, camera, and video settings in the side panel.
4. Click **Export MP4**. The video is saved to your downloads folder as `<file name>_simulation.mp4`.

## Features

- **Realistic preview:** renders each extruded line as a 3D bead with WebGL 2, using line widths calculated from the G-code's extrusion amounts.
- **Print timing:** estimates move times with a look-ahead motion planner that respects the acceleration, feed rate, and jerk limits set in the file.
- **Printer setup:** includes a Prusa MK3S / MK3S+ preset, custom bed dimensions, a custom bed label, and custom bed images (PNG, JPEG, WebP, or SVG).
- **Filament appearance:** offers any color, plus matte, satin, glossy, and silk finishes. The color is read from the G-code when the slicer includes it.
- **Camera modes:** slow orbit, fixed, follow nozzle, and top down.
- **Overlays:** optional nozzle, travel moves, build volume, and a layer, height, and print time display.
- **Bounds check:** warns you when a print extends outside the configured build volume.

## Controls

| Action | Control |
| --- | --- |
| Play or pause | Space, or the play button |
| Seek | Drag the timeline |
| Rotate | Drag |
| Pan | Right-drag, or Shift-drag |
| Zoom | Scroll |
| Reset the view | Double-click |

## Video export

| Setting | Options | Default |
| --- | --- | --- |
| Resolution | 720p, 1080p, 1440p, 4K, square (1080 × 1080), vertical (1080 × 1920) | 1080p |
| Frame rate | 24, 30, or 60 fps | 30 fps |
| Length | 3 to 3600 seconds | 30 seconds |
| Quality | Standard, High, Maximum | High |

The whole print is sped up to fit the length you choose, and every video ends with a 2-second hold on the finished print. Videos use H.264 when the browser supports it and fall back to VP9.

## Browser support

The preview needs WebGL 2 with hardware acceleration turned on. Video export also needs the WebCodecs `VideoEncoder` API, and the app is intended for current versions of Edge and Chrome.

## G-code support

| Commands | Behavior |
| --- | --- |
| `G0`, `G1` | Linear moves |
| `G2`, `G3` | Arcs in the XY plane, using `I`/`J` or `R` |
| `G28` | Homing |
| `G90`, `G91` | Absolute and relative positioning |
| `G92` | Position offsets |
| `M82`, `M83` | Absolute and relative extrusion |
| `M201`, `M203`, `M204`, `M205` | Acceleration, feed rate, and jerk limits |
| `M220` | Feed rate percentage |

Layers are detected from `;LAYER_CHANGE` or `;LAYER:` comments, and from changes in Z height when those comments are missing. `;HEIGHT:` and `;WIDTH:` comments are also used, along with PrusaSlicer-style settings such as `nozzle_diameter` and `filament_diameter`.

### Limitations

- Binary G-code (`.bgcode`) is not supported. Export plain text G-code from your slicer instead.
- Tool changes are ignored, so multi-material prints appear in one color.
- Heating, dwells, and other pauses are not included in the simulated print time.
- Units are assumed to be millimeters.

## Development

The app has no runtime dependencies. [Node.js](https://nodejs.org/) is only needed to rebuild the HTML file or regenerate the sample.

| Path | Purpose |
| --- | --- |
| `src/template.html` | Page markup and styles |
| `src/app.js` | Renderer, user interface, and MP4 export |
| `src/parser.js` | G-code parser and motion-time model, run in a Web Worker |
| `src/build.js` | Inlines the parser and app into the final HTML file |
| `src/make-sample.js` | Generates the sample print |
| `gcode-print-simulator.html` | Built app |
| `sample-mk3s.gcode` | Sample print: a twisted, fluted vase with 220 layers |
| `sample-mk3s_simulation.mp4` | Example video exported from the sample print |

After changing anything in `src/`, rebuild the app:

```powershell
node src/build.js
```

To regenerate the sample print:

```powershell
node src/make-sample.js sample-mk3s.gcode
```
