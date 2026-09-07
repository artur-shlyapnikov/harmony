/**
 * §3.17: the playback stack is a singleton instantiated at application
 * bootstrap — importing @app/dependencies eagerly constructs the shared
 * ProjectTransport (and its AudioEngine underneath) — and the dependencies
 * container hands out that same instance to every consumer.
 */

import { describe, expect, it } from 'vitest';

import { getProjectTransport } from '../../src/audio/projectTransport';
import { getTransportStore } from '../../src/audio/TransportStore';
import { getDependencies } from '../../src/app/dependencies';

describe('ProjectTransport bootstrap singleton (§3.17)', () => {
  it('constructs the transport eagerly and shares it with getDependencies()', () => {
    expect(getDependencies().transport).toBe(getProjectTransport());
    // Eager construction has no side effects: transport stays idle.
    expect(getTransportStore().getSnapshot().status).toBe('idle');
  });
});
