import { assert } from 'chai';
import * as sinon from 'sinon';
import yorkie, {
  Counter,
  ClientEvent,
  ClientStatus,
  SyncMode,
  StreamConnectionStatus,
  DocumentSyncResultType,
  DocEventType,
  ClientEventType,
} from '@yorkie-js-sdk/src/yorkie';
import { waitStubCallCount, deepSort } from '@yorkie-js-sdk/test/helper/helper';
import {
  toDocKey,
  testRPCAddr,
  withTwoClientsAndDocuments,
} from '@yorkie-js-sdk/test/integration/integration_helper';

describe('Client', function () {
  it('Can be activated, deactivated', async function () {
    const clientKey = `${this.test!.title}-${new Date().getTime()}`;
    const clientWithKey = new yorkie.Client(testRPCAddr, {
      key: clientKey,
      syncLoopDuration: 50,
      reconnectStreamDelay: 1000,
    });
    assert.isFalse(clientWithKey.isActive());
    await clientWithKey.activate();
    assert.isTrue(clientWithKey.isActive());
    assert.equal(clientKey, clientWithKey.getKey());
    await clientWithKey.deactivate();
    assert.isFalse(clientWithKey.isActive());

    const clientWithoutKey = new yorkie.Client(testRPCAddr);
    assert.isFalse(clientWithoutKey.isActive());
    await clientWithoutKey.activate();
    assert.isTrue(clientWithoutKey.isActive());
    assert.isString(clientWithoutKey.getKey());
    assert.lengthOf(clientWithoutKey.getKey(), 36);
    await clientWithoutKey.deactivate();
    assert.isFalse(clientWithoutKey.isActive());
  });

  it('Can handle sync', async function () {
    type TestDoc = { k1: string; k2: string; k3: string };
    await withTwoClientsAndDocuments<TestDoc>(async (c1, d1, c2, d2) => {
      const spy = sinon.spy();
      const unsub = d2.subscribe(spy);

      assert.equal(0, spy.callCount);

      d1.update((root) => {
        root['k1'] = 'v1';
      });
      await c1.sync();
      await c2.sync();
      assert.equal(1, spy.callCount);

      d1.update((root) => {
        root['k2'] = 'v2';
      });
      await c1.sync();
      await c2.sync();
      assert.equal(2, spy.callCount);

      unsub();

      d1.update((root) => {
        root['k3'] = 'v3';
      });
      await c1.sync();
      await c2.sync();
      assert.equal(2, spy.callCount);
    }, this.test!.title);
  });

  it('Can recover from temporary disconnect (manual sync)', async function () {
    await withTwoClientsAndDocuments<{ k1: string }>(async (c1, d1, c2, d2) => {
      // Normal Condition
      d2.update((root) => {
        root['k1'] = 'undefined';
      });

      await c2.sync();
      await c1.sync();
      assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

      // Simulate network error
      const xhr = sinon.useFakeXMLHttpRequest();
      xhr.onCreate = (req) => {
        req.respond(
          400,
          {
            'Content-Type': 'application/grpc-web-text+proto',
          },
          '',
        );
      };

      d2.update((root) => {
        root['k1'] = 'v1';
      });

      await c2.sync().catch((err) => {
        assert.equal(err.message, 'INVALID_STATE_ERR - 0');
      });
      await c1.sync().catch((err) => {
        assert.equal(err.message, 'INVALID_STATE_ERR - 0');
      });
      assert.equal(d1.toSortedJSON(), '{"k1":"undefined"}');
      assert.equal(d2.toSortedJSON(), '{"k1":"v1"}');

      // Back to normal condition
      xhr.restore();

      await c2.sync();
      await c1.sync();
      assert.equal(d1.toSortedJSON(), d2.toSortedJSON());
    }, this.test!.title);
  });

  it('Can recover from temporary disconnect (realtime sync)', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ k1: string }>(docKey);
    const d2 = new yorkie.Document<{ k1: string }>(docKey);

    await c1.attach(d1);
    await c2.attach(d2);

    const c1Events: Array<string> = [];
    const c2Events: Array<string> = [];
    const d1Events: Array<string> = [];
    const d2Events: Array<string> = [];

    const stubC1 = sinon.stub().callsFake((event) => {
      c1Events.push(
        event.type === ClientEventType.DocumentSynced
          ? event.value
          : event.type,
      );
    });
    const stubC2 = sinon.stub().callsFake((event) => {
      c2Events.push(
        event.type === ClientEventType.DocumentSynced
          ? event.value
          : event.type,
      );
    });
    const stubD1 = sinon.stub().callsFake((event) => {
      d1Events.push(event.type);
    });
    const stubD2 = sinon.stub().callsFake((event) => {
      d2Events.push(event.type);
    });

    const unsub1 = {
      client: c1.subscribe(stubC1),
      doc: d1.subscribe(stubD1),
    };
    const unsub2 = {
      client: c2.subscribe(stubC2),
      doc: d2.subscribe(stubD2),
    };

    // Normal Condition
    d2.update((root) => {
      root['k1'] = 'undefined';
    });

    await waitStubCallCount(stubD2, 1); // d2 should be able to update
    assert.equal(d2Events.pop(), DocEventType.LocalChange);
    await waitStubCallCount(stubD1, 1); // d1 should be able to receive d2's update
    assert.equal(d1Events.pop(), DocEventType.RemoteChange);
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    // Simulate network error
    const xhr = sinon.useFakeXMLHttpRequest();
    xhr.onCreate = (req) => {
      req.respond(
        400,
        {
          'Content-Type': 'application/grpc-web-text+proto',
        },
        '',
      );
    };

    d2.update((root) => {
      root['k1'] = 'v1';
    });

    await waitStubCallCount(stubD2, 2); // d2 should be able to update
    assert.equal(d2Events.pop(), DocEventType.LocalChange);
    await waitStubCallCount(stubC2, 2); // c2 should fail to sync
    assert.equal(
      c2Events.pop(),
      DocumentSyncResultType.SyncFailed,
      'c2 sync fail',
    );

    c1.sync();
    await waitStubCallCount(stubC1, 4); // c1 should also fail to sync
    assert.equal(
      c1Events.pop(),
      DocumentSyncResultType.SyncFailed,
      'c1 sync fail',
    );
    assert.equal(d1.toSortedJSON(), '{"k1":"undefined"}');
    assert.equal(d2.toSortedJSON(), '{"k1":"v1"}');

    // Back to normal condition
    xhr.restore();

    await waitStubCallCount(stubC2, 4); // wait for c2 to sync
    assert.equal(c2Events.pop(), DocumentSyncResultType.Synced, 'c2 sync');
    await waitStubCallCount(stubC1, 6);
    assert.equal(c1Events.pop(), DocumentSyncResultType.Synced, 'c1 sync');
    await waitStubCallCount(stubD1, 2);
    assert.equal(d1Events.pop(), DocEventType.RemoteChange); // d1 should be able to receive d2's update
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    unsub1.client();
    unsub2.client();
    unsub1.doc();
    unsub2.doc();

    await c1.detach(d1);
    await c2.detach(d2);

    await c1.deactivate();
    await c2.deactivate();
  });

  it('Eventually sync presences with its peers', async function () {
    type PresenceType = {
      name: string;
      cursor: { x: number; y: number };
    };
    const c1 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: {
        name: 'a',
        cursor: { x: 0, y: 0 },
      },
    });
    const c2 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: {
        name: 'b',
        cursor: { x: 1, y: 1 },
      },
    });
    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const doc1 = new yorkie.Document(docKey);
    const doc2 = new yorkie.Document(docKey);

    const stub1 = sinon.stub();
    const stub2 = sinon.stub();
    const unsub1 = c1.subscribe(stub1);
    const unsub2 = c2.subscribe(stub2);

    await c1.activate();
    await c2.activate();

    await c1.attach(doc1);
    await c2.attach(doc2);
    await c1.updatePresence('name', 'A');
    await c2.updatePresence('name', 'B');
    await c2.updatePresence('name', 'Z');
    await c1.updatePresence('cursor', { x: 2, y: 2 });
    await c1.updatePresence('name', 'Y');

    await waitStubCallCount(stub1, 9); // activated, connected, initialized, watched, presence-changed(5)
    await waitStubCallCount(stub2, 8); // activated, connected, initialized, presence-changed(5)
    assert.deepEqual(
      deepSort(c1.getPeersByDocKey(docKey)),
      deepSort(c2.getPeersByDocKey(docKey)),
    );

    await c1.detach(doc1);
    await c2.detach(doc2);
    await c1.deactivate();
    await c2.deactivate();

    unsub1();
    unsub2();
  });

  it('Can get peers watched to the document as an array and object', async function () {
    type PresenceType = {
      name: string;
      cursor: { x: number; y: number };
    };
    const c1Presence = {
      name: 'a',
      cursor: { x: 0, y: 0 },
    };
    const c2Presence = {
      name: 'b',
      cursor: { x: 1, y: 1 },
    };
    const c1 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: { ...c1Presence },
    });
    const c2 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: { ...c2Presence },
    });
    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const doc1 = new yorkie.Document(docKey);
    const doc2 = new yorkie.Document(docKey);

    const stub1 = sinon.stub();
    const stub2 = sinon.stub();
    const unsub1 = c1.subscribe(stub1);
    const unsub2 = c2.subscribe(stub2);

    await c1.activate();
    await c2.activate();
    const c1ID = c1.getID()!;
    const c2ID = c2.getID()!;
    await c1.attach(doc1);
    assert.equal(3, stub1.callCount); // activated, connected, initialized
    await c2.attach(doc2);
    assert.equal(3, stub2.callCount); // activated, connected, initialized
    await waitStubCallCount(stub1, 4);
    assert.equal(4, stub1.callCount); // peers-changed(c2 watched doc)

    const expectedPeers = deepSort([
      { clientID: c1ID, presence: c1Presence },
      { clientID: c2ID, presence: c2Presence },
    ]);
    assert.deepEqual(expectedPeers, deepSort(c1.getPeersByDocKey(docKey)));
    assert.deepEqual(expectedPeers, deepSort(c2.getPeersByDocKey(docKey)));

    await c1.updatePresence('name', 'A');
    await c2.updatePresence('name', 'B');
    await waitStubCallCount(stub1, 6); // presence-changed
    await waitStubCallCount(stub2, 5); // presence-changed

    const expectedPeers2 = deepSort([
      { clientID: c1ID, presence: { ...c1Presence, name: 'A' } },
      { clientID: c2ID, presence: { ...c2Presence, name: 'B' } },
    ]);
    assert.deepEqual(expectedPeers2, deepSort(c1.getPeersByDocKey(docKey)));
    assert.deepEqual(expectedPeers2, deepSort(c2.getPeersByDocKey(docKey)));

    await c1.deactivate();
    await c2.deactivate();

    unsub1();
    unsub2();
  });

  it('client.subscribe correctly detects the events', async function () {
    // The test verifies whether `client.subscribe` correctly detects events
    // when the client performs activate, attach, updatePresence, detach, and deactivate.
    // Please refer to the figure in the yorkie-js-sdk issue for the test code flow.
    // https://github.com/yorkie-team/yorkie-js-sdk/pull/464
    type PresenceType = {
      name: string;
      cursor: { x: number; y: number };
    };
    const c1Presence = {
      name: 'a',
      cursor: { x: 0, y: 0 },
    };
    const c2Presence = {
      name: 'b',
      cursor: { x: 1, y: 1 },
    };
    const c1 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: c1Presence,
    });
    const c2 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: c2Presence,
    });

    const docKey1 = 'event-flow1';
    const docKey2 = 'event-flow2';
    const doc1C1 = new yorkie.Document(docKey1);
    const doc1C2 = new yorkie.Document(docKey1);
    const doc2C1 = new yorkie.Document(docKey2);

    const c1Events: Array<string> = [];
    const c1ExpectedEvents: Array<string> = [];
    const c2Events: Array<string> = [];
    const c2ExpectedEvents: Array<string> = [];
    function pushEvent(array: Array<string>, event: ClientEvent) {
      const sortedEvent = deepSort(event);
      array.push(JSON.stringify(sortedEvent));
    }

    const stub1 = sinon.stub().callsFake((event) => {
      pushEvent(c1Events, event);
    });
    const stub2 = sinon.stub().callsFake((event) => {
      pushEvent(c2Events, event);
    });
    const unsub1 = c1.subscribe(stub1);
    const unsub2 = c2.subscribe(stub2);

    await c1.activate();
    const c1ID = c1.getID()!;
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.StatusChanged,
      value: ClientStatus.Activated,
    });
    assert.equal(1, stub1.callCount);
    assert.deepEqual(
      c1ExpectedEvents,
      c1Events,
      `[c1] c1 activate: \n actual: ${JSON.stringify(
        c1Events,
      )} \n expected: ${JSON.stringify(c1ExpectedEvents)}`,
    );

    await c2.activate();
    const c2ID = c2.getID()!;
    pushEvent(c2ExpectedEvents, {
      type: ClientEventType.StatusChanged,
      value: ClientStatus.Activated,
    });
    assert.equal(1, stub2.callCount);
    assert.deepEqual(
      c2ExpectedEvents,
      c2Events,
      `[c2] c2 activate: \n actual: ${JSON.stringify(
        c2Events,
      )} \n expected: ${JSON.stringify(c2ExpectedEvents)}`,
    );

    await c1.attach(doc1C1);
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.StreamConnectionStatusChanged,
      value: StreamConnectionStatus.Connected,
    });
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.PeersChanged,
      value: {
        type: 'initialized',
        peers: {
          [docKey1]: [{ clientID: c1ID, presence: { ...c1Presence } }],
        },
      },
    });
    assert.equal(3, stub1.callCount);
    assert.deepEqual(
      c1ExpectedEvents,
      c1Events,
      `[c1] c1 attach doc1: \n actual: ${JSON.stringify(
        c1Events,
      )} \n expected: ${JSON.stringify(c1ExpectedEvents)}`,
    );

    await c2.attach(doc1C2);
    pushEvent(c2ExpectedEvents, {
      type: ClientEventType.StreamConnectionStatusChanged,
      value: StreamConnectionStatus.Connected,
    });
    pushEvent(c2ExpectedEvents, {
      type: ClientEventType.PeersChanged,
      value: {
        type: 'initialized',
        peers: {
          [docKey1]: [
            { clientID: c1ID, presence: { ...c1Presence } },
            { clientID: c2ID, presence: { ...c2Presence } },
          ],
        },
      },
    });
    assert.equal(3, stub2.callCount);
    assert.deepEqual(
      c2ExpectedEvents,
      c2Events,
      `[c2] c2 attach doc1: \n actual: ${JSON.stringify(
        c2Events,
      )} \n expected: ${JSON.stringify(c2ExpectedEvents)}`,
    );

    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.PeersChanged,
      value: {
        type: 'watched',
        peers: {
          [docKey1]: [{ clientID: c2ID, presence: { ...c2Presence } }],
        },
      },
    });
    await waitStubCallCount(stub1, 4);
    assert.equal(4, stub1.callCount);
    assert.deepEqual(
      c1ExpectedEvents,
      c1Events,
      `[c1] c2 attach doc1: \n actual: ${JSON.stringify(
        c1Events,
      )} \n expected: ${JSON.stringify(c1ExpectedEvents)}`,
    );

    await c1.updatePresence('name', 'z');
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.PeersChanged,
      value: {
        type: 'presence-changed',
        peers: {
          [docKey1]: [
            { clientID: c1ID, presence: { ...c1Presence, name: 'z' } },
          ],
        },
      },
    });
    assert.equal(5, stub1.callCount);
    assert.deepEqual(
      c1ExpectedEvents,
      c1Events,
      `[c1] c1 updatePresence: \n actual: ${JSON.stringify(
        c1Events,
      )} \n expected: ${JSON.stringify(c1ExpectedEvents)}`,
    );

    pushEvent(c2ExpectedEvents, {
      type: ClientEventType.PeersChanged,
      value: {
        type: 'presence-changed',
        peers: {
          [docKey1]: [
            { clientID: c1ID, presence: { ...c1Presence, name: 'z' } },
          ],
        },
      },
    });
    await waitStubCallCount(stub2, 4);
    assert.equal(4, stub2.callCount);
    assert.deepEqual(
      c2ExpectedEvents,
      c2Events,
      `[c2] c1 updatePresence: \n actual: ${JSON.stringify(
        c2Events,
      )} \n expected: ${JSON.stringify(c2ExpectedEvents)}`,
    );

    await c1.attach(doc2C1);
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.StreamConnectionStatusChanged,
      value: StreamConnectionStatus.Connected,
    });
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.PeersChanged,
      value: {
        type: 'initialized',
        peers: {
          [docKey2]: [
            { clientID: c1ID, presence: { ...c1Presence, name: 'z' } },
          ],
        },
      },
    });
    assert.equal(7, stub1.callCount);
    assert.deepEqual(
      c1ExpectedEvents,
      c1Events,
      `[c1] c1 attach doc2: \n actual: ${JSON.stringify(
        c1Events,
      )} \n expected: ${JSON.stringify(c1ExpectedEvents)}`,
    );

    await c1.detach(doc1C1);
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.StreamConnectionStatusChanged,
      value: StreamConnectionStatus.Disconnected,
    });
    assert.equal(8, stub1.callCount);
    assert.deepEqual(
      c1ExpectedEvents,
      c1Events,
      `[c1] c1 detach doc1: \n actual: ${JSON.stringify(
        c1Events,
      )} \n expected: ${JSON.stringify(c1ExpectedEvents)}`,
    );

    pushEvent(c2ExpectedEvents, {
      type: ClientEventType.PeersChanged,
      value: {
        type: 'unwatched',
        peers: {
          [docKey1]: [
            { clientID: c1ID, presence: { ...c1Presence, name: 'z' } },
          ],
        },
      },
    });
    await waitStubCallCount(stub2, 5);
    assert.equal(5, stub2.callCount);
    assert.deepEqual(
      c2ExpectedEvents,
      c2Events,
      `[c2] c1 detach doc1: \n actual: ${JSON.stringify(
        c2Events,
      )} \n expected: ${JSON.stringify(c2ExpectedEvents)}`,
    );

    await c1.deactivate();
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.StreamConnectionStatusChanged,
      value: StreamConnectionStatus.Disconnected,
    });
    pushEvent(c1ExpectedEvents, {
      type: ClientEventType.StatusChanged,
      value: ClientStatus.Deactivated,
    });
    assert.equal(10, stub1.callCount);
    assert.deepEqual(
      c1ExpectedEvents,
      c1Events,
      `[c1] c1 deactivate: \n actual: ${JSON.stringify(
        c1Events,
      )} \n expected: ${JSON.stringify(c1ExpectedEvents)}`,
    );

    await c2.detach(doc1C2);
    pushEvent(c2ExpectedEvents, {
      type: ClientEventType.StreamConnectionStatusChanged,
      value: StreamConnectionStatus.Disconnected,
    });
    assert.equal(6, stub2.callCount);
    assert.deepEqual(
      c2ExpectedEvents,
      c2Events,
      `[c2] c2 detach doc1: \n actual: ${JSON.stringify(
        c2Events,
      )} \n expected: ${JSON.stringify(c2ExpectedEvents)}`,
    );

    await c2.deactivate();
    pushEvent(c2ExpectedEvents, {
      type: ClientEventType.StatusChanged,
      value: ClientStatus.Deactivated,
    });
    assert.equal(7, stub2.callCount);
    assert.deepEqual(
      c2ExpectedEvents,
      c2Events,
      `[c2] c2 deactivate: \n actual: ${JSON.stringify(
        c2Events,
      )} \n expected: ${JSON.stringify(c2ExpectedEvents)}`,
    );

    unsub1();
    unsub2();
  });

  it('Can change realtime sync', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ version: string }>(docKey);
    const d2 = new yorkie.Document<{ version: string }>(docKey);

    // 01. c1 and c2 attach the doc with manual sync mode.
    //     c1 updates the doc, but c2 does't get until call sync manually.
    await c1.attach(d1, true);
    await c2.attach(d2, true);
    d1.update((root) => {
      root.version = 'v1';
    });
    assert.notEqual(d1.toSortedJSON(), d2.toSortedJSON());
    await c1.sync();
    await c2.sync();
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    // 02. c2 changes the sync mode to realtime sync mode.
    const c2Events: Array<string> = [];
    const stubC2 = sinon.stub().callsFake((event) => {
      c2Events.push(event.type);
    });
    const unsub1 = c2.subscribe(stubC2);
    await c2.resume(d2);
    d1.update((root) => {
      root.version = 'v2';
    });
    await c1.sync();
    await waitStubCallCount(stubC2, 2);
    assert.equal(c2Events.pop(), ClientEventType.DocumentSynced);
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());
    unsub1();

    // 03. c2 changes the sync mode to manual sync mode again.
    await c2.pause(d2);
    d1.update((root) => {
      root.version = 'v3';
    });
    assert.notEqual(d1.toSortedJSON(), d2.toSortedJSON());
    await c1.sync();
    await c2.sync();
    assert.equal(d1.toSortedJSON(), d2.toSortedJSON());

    await c1.deactivate();
    await c2.deactivate();
  });

  it('Can change sync mode in manual sync', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    const c3 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();
    await c3.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d2 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d3 = new yorkie.Document<{ c1: number; c2: number }>(docKey);

    // 01. c1, c2, c3 attach to the same document in manual sync.
    await c1.attach(d1, true);
    await c2.attach(d2, true);
    await c3.attach(d3, true);

    // 02. c1, c2 sync with push-pull mode.
    d1.update((root) => {
      root.c1 = 0;
    });
    d2.update((root) => {
      root.c2 = 0;
    });

    await c1.sync();
    await c2.sync();
    await c1.sync();
    assert.equal(d1.toSortedJSON(), '{"c1":0,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":0}');

    // 03. c1 and c2 sync with push-only mode. So, the changes of c1 and c2
    // are not reflected to each other.
    // But, c3 can get the changes of c1 and c2, because c3 sync with pull-pull mode.
    d1.update((root) => {
      root.c1 = 1;
    });
    d2.update((root) => {
      root.c2 = 1;
    });
    await c1.sync(d1, SyncMode.PushOnly);
    await c2.sync(d2, SyncMode.PushOnly);
    await c3.sync();
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":1}');
    assert.equal(d3.toSortedJSON(), '{"c1":1,"c2":1}');

    // 04. c1 and c2 sync with push-pull mode.
    await c1.sync();
    await c2.sync();
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":1}');
    assert.equal(d2.toSortedJSON(), '{"c1":1,"c2":1}');

    await c1.deactivate();
    await c2.deactivate();
    await c3.deactivate();
  });

  it('Can change sync mode in realtime sync', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    const c2 = new yorkie.Client(testRPCAddr);
    const c3 = new yorkie.Client(testRPCAddr);
    await c1.activate();
    await c2.activate();
    await c3.activate();

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d2 = new yorkie.Document<{ c1: number; c2: number }>(docKey);
    const d3 = new yorkie.Document<{ c1: number; c2: number }>(docKey);

    // 01. c1, c2, c3 attach to the same document in realtime sync.
    await c1.attach(d1);
    await c2.attach(d2);
    await c3.attach(d3);

    const d1Events: Array<string> = [];
    const d2Events: Array<string> = [];
    const d3Events: Array<string> = [];
    const stub1 = sinon.stub().callsFake((event) => {
      d1Events.push(event.type);
    });
    const stub2 = sinon.stub().callsFake((event) => {
      d2Events.push(event.type);
    });
    const stub3 = sinon.stub().callsFake((event) => {
      d3Events.push(event.type);
    });
    const unsub1 = d1.subscribe(stub1);
    const unsub2 = d2.subscribe(stub2);
    const unsub3 = d3.subscribe(stub3);

    // 02. c1, c2 sync in realtime.
    d1.update((root) => {
      root.c1 = 0;
    });
    d2.update((root) => {
      root.c2 = 0;
    });
    await waitStubCallCount(stub1, 2); // local-change, remote-change
    await waitStubCallCount(stub2, 2); // local-change, remote-change
    assert.equal(d1.toSortedJSON(), '{"c1":0,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":0}');

    // 03. c1 and c2 sync with push-only mode. So, the changes of c1 and c2
    // are not reflected to each other.
    // But, c3 can get the changes of c1 and c2, because c3 sync with pull-pull mode.
    c1.pauseRemoteChanges(d1);
    c2.pauseRemoteChanges(d2);
    d1.update((root) => {
      root.c1 = 1;
    });
    d2.update((root) => {
      root.c2 = 1;
    });

    await waitStubCallCount(stub1, 3); // local-change
    await waitStubCallCount(stub2, 3); // local-change
    await waitStubCallCount(stub3, 3);
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":0}');
    assert.equal(d2.toSortedJSON(), '{"c1":0,"c2":1}');
    assert.equal(d3.toSortedJSON(), '{"c1":1,"c2":1}');

    // 04. c1 and c2 sync with push-pull mode.
    c1.resumeRemoteChanges(d1);
    c2.resumeRemoteChanges(d2);
    await waitStubCallCount(stub1, 4);
    await waitStubCallCount(stub2, 4);
    assert.equal(d1.toSortedJSON(), '{"c1":1,"c2":1}');
    assert.equal(d2.toSortedJSON(), '{"c1":1,"c2":1}');

    unsub1();
    unsub2();
    unsub3();
    await c1.deactivate();
    await c2.deactivate();
    await c3.deactivate();
  });

  it('sync option with mixed mode test', async function () {
    const c1 = new yorkie.Client(testRPCAddr);
    await c1.activate();

    // 01. cli attach to the document having counter.
    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ counter: Counter }>(docKey);
    await c1.attach(d1, true);

    // 02. cli update the document with creating a counter
    //     and sync with push-pull mode: CP(0, 0) -> CP(1, 1)
    d1.update((root) => {
      root.counter = new yorkie.Counter(yorkie.IntType, 0);
    });

    let checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 0);
    assert.equal(checkpoint.getServerSeq().toInt(), 0);

    await c1.sync();
    checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 1);
    assert.equal(checkpoint.getServerSeq().toInt(), 1);

    // 03. cli update the document with increasing the counter(0 -> 1)
    //     and sync with push-only mode: CP(1, 1) -> CP(2, 1)
    d1.update((root) => {
      root.counter.increase(1);
    });
    let changePack = d1.createChangePack();
    assert.equal(changePack.getChangeSize(), 1);

    await c1.sync(d1, SyncMode.PushOnly);
    checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 2);
    assert.equal(checkpoint.getServerSeq().toInt(), 1);

    // 04. cli update the document with increasing the counter(1 -> 2)
    //     and sync with push-pull mode. CP(2, 1) -> CP(3, 3)
    d1.update((root) => {
      root.counter.increase(1);
    });

    // The previous increase(0 -> 1) is already pushed to the server,
    // so the ChangePack of the request only has the increase(1 -> 2).
    changePack = d1.createChangePack();
    assert.equal(changePack.getChangeSize(), 1);

    await c1.sync();
    checkpoint = d1.getCheckpoint();
    assert.equal(checkpoint.getClientSeq(), 3);
    assert.equal(checkpoint.getServerSeq().toInt(), 3);
    assert.equal(d1.getRoot().counter.getValue(), 2);

    await c1.deactivate();
  });

  it(`Can get peer's presence`, async function () {
    type PresenceType = {
      name: string;
      cursor: { x: number; y: number };
    };
    const c1 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: {
        name: 'a',
        cursor: { x: 0, y: 0 },
      },
    });
    const c2 = new yorkie.Client<PresenceType>(testRPCAddr, {
      presence: {
        name: 'b',
        cursor: { x: 1, y: 1 },
      },
    });
    await c1.activate();
    await c2.activate();

    const stub1 = sinon.stub();
    const unsub1 = c1.subscribe(stub1);

    const docKey = toDocKey(`${this.test!.title}-${new Date().getTime()}`);
    const d1 = new yorkie.Document<{ version: string }>(docKey);
    const d2 = new yorkie.Document<{ version: string }>(docKey);

    await c1.attach(d1);
    await waitStubCallCount(stub1, 2); // connected, initialized
    assert.deepEqual(c1.getPeerPresence(docKey, c2.getID()!), undefined);

    await c2.attach(d2);
    await waitStubCallCount(stub1, 3); // watched
    assert.deepEqual(c1.getPeerPresence(docKey, c2.getID()!), {
      name: 'b',
      cursor: { x: 1, y: 1 },
    });

    unsub1();
    await c1.deactivate();
    await c2.deactivate();
  });
});
