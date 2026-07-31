export { Grid, type CellData } from './grid/grid.js';
// El layout de celda lo necesita cualquier backend que quiera leer `grid.cells` sin pagar un
// objeto por celda — que es lo que separa un render de 20 000 asignaciones por cuadro de uno de
// cero (ver `renderer-canvas`).
export { BYTES_PER_CELL, CELL_OFFSET } from './grid/layout.js';

export { PALETTE, PAL, paletteColor, type Palette } from './palette/palette.js';

export type {
  Body,
  ElevationBand,
  AtmosphereSpec,
  RotationSpec,
  DatasetManifest,
} from './body.js';

export {
  type LodLevel,
  type LodRung,
  LOD_LEVELS,
  LOD_LADDER,
  lodForAltitude,
  rungFor,
  lodIndex,
  clampToAvailable,
} from './lod/ladder.js';
export { LodTracker, lodWithHysteresis, HYSTERESIS } from './lod/hysteresis.js';

export { Camera, type CameraOptions } from './camera/camera.js';
export { beginDrag, dragTo, type DragState } from './camera/drag.js';
export {
  normalizeWheel,
  zoomAltitude,
  zoomToward,
  anchorZoom,
  zoomStep,
  applyZoom,
  ZOOM_SENSITIVITY,
  ZOOM_ACCELERATION,
  type ZoomResult,
} from './camera/wheel.js';
export { planFlight, type Flight, type FlyOptions } from './camera/fly-to.js';
export {
  damp,
  dampAngle,
  dampAltitude,
  ALTITUDE_TIME_CONSTANT_MS,
  ROTATION_TIME_CONSTANT_MS,
} from './camera/damping.js';

export {
  NavigationController,
  type NavigationOptions,
} from './input/pointer.js';
export {
  describeGesture,
  gestureDelta,
  type TwoPointGesture,
  type GestureDelta,
} from './input/gestures.js';
export {
  type CameraState,
  CAMERA_DEFAULTS,
  MIN_ALT_KM,
  MAX_ALT_KM,
  createCameraState,
  normalizeCameraState,
  clamp,
  wrapLon,
  wrapBearing,
} from './camera/state.js';

export {
  CELL_ASPECT,
  FOV_DEG,
  type ViewMetrics,
  createViewMetrics,
  viewportHalfRows,
  groundAngleRad,
} from './projection/aspect.js';
export type { Projection, SubcellProjection } from './projection/projection.js';
export { buildProjection } from './projection/satellite.js';
export { isVisible, cameraDistance, horizonAngleRad } from './projection/visibility.js';

export {
  buildChrome,
  NO_CHROME,
  type ChromeCommands,
  type LimbRing,
  type AtmosphereHalo,
} from './chrome.js';

export {
  type Scene,
  type FrameOptions,
  type Pipeline,
  singleBodyScene,
  createPipeline,
} from './pipeline.js';

export {
  type Layer,
  type LayerKind,
  type SampleContext,
  createSampleContext,
  paintBodySilhouette,
} from './layers/types.js';
export { LayerStack, type LayerPosition } from './layers/stack.js';
export {
  CollisionGrid,
  placeLabels,
  LABEL_ANCHORS,
  type LabelBox,
  type PlacedLabel,
  type LabelCandidate,
} from './labels/collision.js';

export {
  SUB_X,
  SUB_Y,
  LINE_CLASS,
  type LineClass,
  type SampleBuffer,
  createSampleBuffer,
  fillRings,
  strokeRings,
  PathSink,
} from './raster/sample-buffer.js';
export {
  reduce,
  REGISTER,
  type Register,
  type ReduceOptions,
  type ReduceResult,
  type ReliefSettings,
  DEFAULT_REDUCE_OPTIONS,
  DEFAULT_RELIEF,
} from './raster/reduce.js';
export { sobelAt, type Gradient } from './raster/sobel.js';
export {
  extractContours,
  contourIntervalM,
  adaptiveIntervalM,
  meanRisePerSubcellM,
  type ContourOptions,
} from './raster/contour.js';
export { embossShift, applyShift, EMBOSS_MIN, type EmbossShift } from './raster/emboss.js';
export {
  applyCoastalShadow,
  coastalShadowWidth,
  type CoastalShadowOptions,
} from './raster/coastal-shadow.js';
export {
  subsolarPoint,
  solarIncidence,
  solarScreenDirection,
  type SubsolarPoint,
} from './math/solar.js';
export { edgeGlyph, DIRECTIONAL_GLYPHS } from './raster/registers/directional.js';
export {
  selectBand,
  semanticGlyph,
  limitBands,
} from './raster/registers/semantic.js';

export {
  BRAILLE_BASE,
  BRAILLE_BIT,
  brailleChar,
  setSub,
  type BrailleCol,
  type BrailleRow,
} from './raster/registers/braille.js';
export { QUADRANT, QUADRANT_BIT, quadrantChar } from './raster/registers/quadrant.js';

export {
  CHARSETS,
  BRAILLE_CHARSET,
  QUADRANT_CHARSET,
  ASCII_CHARSET,
  BLANK_CODEPOINTS,
  fullCharset,
  type CharsetRole,
} from './charset/charsets.js';
export { computeDensity } from './charset/density.js';
export { detectMissing } from './charset/coverage.js';
export { buildAtlas, type GlyphAtlas, type GlyphSampler, type BuildAtlasOptions } from './charset/atlas.js';
