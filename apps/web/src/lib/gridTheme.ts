import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({
  browserColorScheme: 'dark',
  backgroundColor: '#0c1017',
  foregroundColor: '#dfe4ec',
  chromeBackgroundColor: '#0c1017',
  headerBackgroundColor: '#0a0d13',
  headerTextColor: '#6b7587',
  headerFontSize: 10,
  headerFontWeight: 600,
  headerHeight: 26,
  headerColumnResizeHandleColor: '#283244',
  borderColor: '#1c2431',
  rowBorder: { color: '#141a24' },
  columnBorder: false,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  oddRowBackgroundColor: '#0d121a',
  rowHoverColor: '#141c28',
  selectedRowBackgroundColor: '#15233a',
  accentColor: '#3d8bfd',
  fontFamily: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
  fontSize: 12,
  rowHeight: 26,
  spacing: 4,
  cellHorizontalPadding: 8,
  iconSize: 12,
});
