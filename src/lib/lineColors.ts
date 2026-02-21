// Official TfL line colors
// Source: https://tfl.gov.uk/info-for/media/colour-standard

export const LINE_COLORS: Record<string, string> = {
  'Bakerloo': '#B36305',
  'Central': '#E32017',
  'Circle': '#FFD300',
  'District': '#00782A',
  'Hammersmith & City': '#F3A9BB',
  'Jubilee': '#A0A5A9',
  'Metropolitan': '#9B0056',
  'Northern': '#000000',
  'Piccadilly': '#003688',
  'Victoria': '#0098D4',
  'Waterloo & City': '#95CDBA',
  // Additional lines (not in MVP but included in data)
  'Elizabeth': '#7156A5',
  'London Overground': '#EE7C0E',
  'DLR': '#00A4A7',
  'Tram': '#84B817',
};

// TfL line codes used in TrackerNet API
export const LINE_CODES: Record<string, string> = {
  'B': 'Bakerloo',
  'C': 'Central',
  'D': 'District',
  'H': 'Hammersmith & City',
  'J': 'Jubilee',
  'M': 'Metropolitan',
  'N': 'Northern',
  'P': 'Piccadilly',
  'V': 'Victoria',
  'W': 'Waterloo & City',
  'L': 'Circle', // Circle line code
};

// Lines to show in MVP (Underground only)
export const UNDERGROUND_LINES = [
  'Bakerloo',
  'Central',
  'Circle',
  'District',
  'Hammersmith & City',
  'Jubilee',
  'Metropolitan',
  'Northern',
  'Piccadilly',
  'Victoria',
  'Waterloo & City',
];

export function getLineColor(lineName: string): string {
  return LINE_COLORS[lineName] || '#888888';
}

export function isUndergroundLine(lineName: string): boolean {
  return UNDERGROUND_LINES.includes(lineName);
}
