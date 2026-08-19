/**
 * The single stand-in for `CostChart`, shared by every suite that mocks it.
 *
 * `mock.module` registrations are global to a test run, so two suites registering
 * different doubles for one path means the winner depends on file order. When the
 * doubles disagree on height the visual capture silently changes layout, which reads
 * as a palette regression. One definition removes the possibility.
 *
 * The height stands in for the canvas echarts would draw, which happy-dom cannot
 * provide and which would not paint identically twice anyway.
 */
export function CostChartDouble({ kind, zoomContext }: { kind: string; zoomContext: string }) {
  return <div data-testid={`${kind}-chart`} data-zoom-context={zoomContext} style={{ height: "260px" }} />;
}
