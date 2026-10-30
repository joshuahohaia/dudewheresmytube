import { describe, it, expect } from 'vitest';
import { updateMotion, motionTarget, routeStations, type MotionTrain } from './trainMotion';
import { getStationCoordinates } from './stationLookup';

const NOW = 1_800_000_000_000;

function makeTrain(overrides: Partial<MotionTrain> = {}): MotionTrain {
  return {
    id: 'bakerloo-211',
    lineId: 'bakerloo',
    currentStation: "Queen's Park",
    destination: 'Elephant & Castle',
    timeToStation: 81,
    ...overrides,
  };
}

function roughly(a: [number, number], b: [number, number], tolDeg = 1e-4) {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(tolDeg);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(tolDeg);
}

describe('routeStations', () => {
  it('routes along a line in station order', () => {
    const route = routeStations('Bakerloo', "Queen's Park", 'Elephant & Castle');
    expect(route).not.toBeNull();
    expect(route![0]).toBe("Queen's Park");
    expect(route![route!.length - 1]).toBe('Elephant & Castle');
    expect(route).toContain('Oxford Circus');
    // southbound from Queen's Park goes via Kilburn Park, not Kensal Green
    expect(route![1]).toBe('Kilburn Park');
  });

  it('returns null for stations not on the line', () => {
    expect(routeStations('Bakerloo', 'Morden', 'Elephant & Castle')).toBeNull();
    expect(routeStations('Not A Line', 'A', 'B')).toBeNull();
  });
});

describe('updateMotion: new train', () => {
  it('places a new train between the previous station and its target', () => {
    const state = updateMotion(undefined, makeTrain(), NOW)!;
    expect(state).not.toBeNull();
    // walking back southbound from Queen's Park starts at Kensal Green
    expect(state.originStation).toBe('Kensal Green');
    expect(state.path).not.toBeNull();

    const queensPark = getStationCoordinates("Queen's Park")!;
    const kensalGreen = getStationCoordinates('Kensal Green')!;

    const { position } = motionTarget(state, NOW);
    // 81s out of an estimated ~one leg: between the two stations, not on either
    const dQ = Math.hypot(position[0] - queensPark[0], position[1] - queensPark[1]);
    const dK = Math.hypot(position[0] - kensalGreen[0], position[1] - kensalGreen[1]);
    expect(dQ).toBeGreaterThan(1e-4);
    expect(dK).toBeGreaterThan(1e-4);
  });

  it('moves toward the target as the countdown elapses and arrives at tts=0', () => {
    const state = updateMotion(undefined, makeTrain({ timeToStation: 81 }), NOW)!;
    const target = getStationCoordinates("Queen's Park")!;

    const early = motionTarget(state, NOW).position;
    const late = motionTarget(state, NOW + 40_000).position;
    const dEarly = Math.hypot(early[0] - target[0], early[1] - target[1]);
    const dLate = Math.hypot(late[0] - target[0], late[1] - target[1]);
    expect(dLate).toBeLessThan(dEarly);

    const atArrival = motionTarget(state, NOW + 81_000).position;
    roughly(atArrival, target);
  });

  it('clamps very long countdowns at the furthest walked-back station', () => {
    const state = updateMotion(undefined, makeTrain({ timeToStation: 299 }), NOW)!;
    const { position } = motionTarget(state, NOW);
    expect(Number.isFinite(position[0])).toBe(true);
    expect(Number.isFinite(position[1])).toBe(true);
    // never beyond the start of the path
    const start = state.path![0];
    const atStart = motionTarget(state, NOW - 999_000_000).position;
    roughly(atStart, motionTarget(state, NOW).position);
    void start;
    void position;
  });
});

describe('updateMotion: prediction flips to the next station', () => {
  it('comes from the previous target station after a flip', () => {
    const first = updateMotion(undefined, makeTrain(), NOW)!;
    const flipped = updateMotion(
      first,
      makeTrain({ currentStation: 'Kilburn Park', timeToStation: 90 }),
      NOW + 81_000
    )!;
    expect(flipped.originStation).toBe(first.originStation);
    expect(flipped.targetStation).toBe('Kilburn Park');

    // just after the flip the train is near the station it left
    const qp = getStationCoordinates("Queen's Park")!;
    const kp = getStationCoordinates('Kilburn Park')!;
    const { position } = motionTarget(flipped, NOW + 81_000);
    const dQP = Math.hypot(position[0] - qp[0], position[1] - qp[1]);
    const dKP = Math.hypot(position[0] - kp[0], position[1] - kp[1]);
    expect(dQP).toBeLessThan(dKP);
  });

  it('handles a reroute to an unexpected station without crashing', () => {
    const first = updateMotion(undefined, makeTrain(), NOW)!;
    const rerouted = updateMotion(
      first,
      makeTrain({ currentStation: 'Paddington', destination: 'Elephant & Castle', timeToStation: 120 }),
      NOW + 30_000
    )!;
    expect(rerouted.targetStation).toBe('Paddington');
    const { position } = motionTarget(rerouted, NOW + 30_000);
    expect(Number.isFinite(position[0])).toBe(true);
    expect(Number.isFinite(position[1])).toBe(true);
  });
});

describe('updateMotion: same-target corrections', () => {
  it('ignores small countdown jitter between polls', () => {
    const first = updateMotion(undefined, makeTrain({ timeToStation: 81 }), NOW)!;
    // 10s later the feed says 73s (2s of jitter vs the expected 71s)
    const next = updateMotion(first, makeTrain({ timeToStation: 73 }), NOW + 10_000)!;
    expect(next.arrivalTime).toBe(first.arrivalTime);
  });

  it('adopts large corrections (held train)', () => {
    const first = updateMotion(undefined, makeTrain({ timeToStation: 30 }), NOW)!;
    // 20s later the feed still says 45s: the train is being held
    const next = updateMotion(first, makeTrain({ timeToStation: 45 }), NOW + 20_000)!;
    expect(next.arrivalTime).toBe(NOW + 20_000 + 45_000);
  });
});

describe('motionTarget: dwell and stale data', () => {
  it('holds at the station after arrival and never invents a departure', () => {
    const state = updateMotion(undefined, makeTrain({ timeToStation: 10 }), NOW)!;
    const target = getStationCoordinates("Queen's Park")!;
    // long dwell: feed keeps showing the train at the platform
    for (const t of [10_000, 60_000, 300_000]) {
      const { position } = motionTarget(state, NOW + t);
      roughly(position, target);
    }
  });

  it('keeps the last predicted position when the feed goes stale', () => {
    const state = updateMotion(undefined, makeTrain({ timeToStation: 200 }), NOW)!;
    // no further updates; the countdown elapses and the train dwells
    const { position } = motionTarget(state, NOW + 600_000);
    roughly(position, motionTarget(state, NOW + 90_000).position);
  });
});

describe('updateMotion: unmappable data', () => {
  it('returns null for a station that cannot be placed', () => {
    expect(
      updateMotion(undefined, makeTrain({ currentStation: 'Atlantis' }), NOW)
    ).toBeNull();
  });

  it('falls back to sitting at the target when the line has no geometry', () => {
    const state = updateMotion(
      undefined,
      { id: 'x-1', lineId: 'not-a-line', currentStation: "Queen's Park", destination: 'Nowhere', timeToStation: 60 },
      NOW
    )!;
    expect(state.path).toBeNull();
    const { position } = motionTarget(state, NOW);
    roughly(position, motionTarget(state, NOW + 90_000).position);
  });
});


describe('production regressions', () => {
  it('connects Central and Metropolitan branches using explicit station IDs', () => {
    expect(routeStations('Central','Oxford Circus','Ealing Broadway')).toContain('West Acton');
    expect(routeStations('Metropolitan','Baker Street','Watford')).toContain('Moor Park');
  });
  it('uses absolute arrival rather than restarting a cached countdown', () => {
    const train = makeTrain({expectedArrival: new Date(NOW+60_000).toISOString(), timeToStation:120});
    const a = updateMotion(undefined, train, NOW)!;
    const b = updateMotion(a, train, NOW+30_000)!;
    expect(b.arrivalTime).toBe(NOW+60_000);
    expect(b.startedAt).toBe(a.startedAt);
    expect(motionTarget(b,NOW+60_000).position).toEqual(b.targetCoords);
  });
  it('delayed predictions do not move a train backwards', () => {
    const a = updateMotion(undefined,makeTrain({timeToStation:60}),NOW)!;
    const before = motionTarget(a,NOW+20_000).position;
    const b = updateMotion(a,makeTrain({timeToStation:120}),NOW+20_000)!;
    roughly(motionTarget(b,NOW+20_000).position,before,1e-9);
    expect(motionTarget(b,NOW+21_000).position).not.toEqual(before);
  });
  it('early station flips preserve the displayed position on track', () => {
    const a=updateMotion(undefined,makeTrain({timeToStation:81}),NOW)!;
    const before=motionTarget(a,NOW+50_000).position;
    const b=updateMotion(a,makeTrain({currentStation:'Kilburn Park',timeToStation:90}),NOW+50_000)!;
    roughly(motionTarget(b,NOW+50_000).position,before,1e-6);
  });
  it('moves immediately even when a countdown exceeds the estimated segment duration', () => {
    const a=updateMotion(undefined,makeTrain(),NOW)!;
    const b=updateMotion(a,makeTrain({currentStation:'Kilburn Park',timeToStation:299}),NOW+81_000)!;
    expect(motionTarget(b,NOW+82_000).position).not.toEqual(motionTarget(b,NOW+81_000).position);
  });
  it('uses NaPTAN IDs for decorated platform station names', () => {
    const state=updateMotion(undefined,makeTrain({lineId:'hammersmith-city',currentStation:'Paddington (H&C Line)-Underground',naptanId:'940GZZLUPAH',destination:'Barking'}),NOW)!;
    expect(state.targetStation).toBe('Paddington');
    expect(state.path).not.toBeNull();
  });
});

it('preserves the old approach at a station flip instead of shortcutting a junction',()=>{
 const train=makeTrain({currentStation:'Paddington',timeToStation:120,destination:'Harrow & Wealdstone'});
 const a=updateMotion(undefined,train,NOW)!;
 const before=motionTarget(a,NOW+10_000).position;
 const b=updateMotion(a,{...train,currentStation:'Warwick Avenue',timeToStation:120},NOW+10_000)!;
 roughly(motionTarget(b,NOW+10_000).position,before,1e-9);
 const after=motionTarget(b,NOW+11_000).position;
 expect(Math.hypot((after[0]-before[0])*69000,(after[1]-before[1])*110540)).toBeLessThan(26);
});
