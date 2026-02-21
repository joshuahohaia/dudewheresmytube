export interface Train {
  id: string;
  lineId: string;
  lineName: string;
  currentStation: string;
  destination: string;
  timeToStation: number; // seconds
  direction: string;
  vehicleId: string;
  naptanId: string;
}

export interface TrainWithPosition extends Train {
  position: [number, number]; // [lng, lat]
  heading: number; // degrees from north
}

export interface TrainsResponse {
  trains: Train[];
  timestamp: number;
  cached: boolean;
  count?: number;
  error?: string;
}
