/** A steady caret stays drawn. A blinking caret follows the phase bit. */
export function cursorPaintPhase(blinkEnabled: boolean, phaseOn: boolean): boolean {
  return blinkEnabled ? phaseOn : true;
}
