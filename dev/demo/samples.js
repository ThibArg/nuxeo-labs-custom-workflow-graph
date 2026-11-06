/*
 * (C) Copyright 2026 Hyland (http://hyland.com/) and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Contributors:
 *     Thibaud Arguillere
 */

/*
 * Development fixtures (NOT packaged): REST responses of a Nuxeo LTS 2025 server, rebuilt from the
 * workflow definitions shipped with Nuxeo (nuxeo-routing-default: SerialDocumentReview and
 * ParallelDocumentReview; nuxeo-routing-rest-api tests: MainWF) plus a synthetic workflow exercising
 * fork, merge, waiting branch, back edge, sub-workflow and long titles.
 *
 * Node titles and transition labels are already translated, as the server does with its messages bundle
 * (untranslated keys such as "automatic_transition" are returned as is). All persons are fictitious.
 */
(function (root) {
  'use strict';

  function node(id, title, x, y, state, extra) {
    return Object.assign(
      {
        x,
        y,
        isForkNode: false,
        isStartNode: false,
        isEndNode: false,
        id,
        title,
        state,
        isMerge: false,
        isMultiTask: false,
        hasSubWorkflow: false,
      },
      extra || {},
    );
  }

  function tr(source, target, label, path) {
    return { nodeSourceId: source, nodeTargetId: target, label, path: path || [] };
  }

  function pts(...coords) {
    const list = [];
    for (let i = 0; i < coords.length; i += 2) {
      list.push({ x: coords[i], y: coords[i + 1] });
    }
    return list;
  }

  function user(id, firstName, lastName) {
    return {
      'entity-type': 'user',
      id,
      properties: {
        username: id,
        firstName,
        lastName,
        email: `${id}@example.com`,
      },
    };
  }

  function group(id, label) {
    return { 'entity-type': 'group', id, groupname: id, grouplabel: label };
  }

  function workflow(id, name, title, initiator) {
    return {
      'entity-type': 'workflow',
      id,
      name,
      title,
      state: 'running',
      workflowModelName: name,
      initiator,
      attachedDocumentIds: [{ id: 'doc-0001' }],
      variables: {},
      graphResource: `http://localhost/nuxeo/api/v1/workflow/${id}/graph`,
    };
  }

  function task(id, wfId, nodeName, name, opts) {
    return Object.assign(
      {
        'entity-type': 'task',
        id,
        name,
        workflowInstanceId: wfId,
        workflowModelName: '',
        state: 'opened',
        directive: '',
        created: '2026-10-28T09:12:00.000Z',
        dueDate: '2026-11-20T17:00:00.000Z',
        nodeName,
        targetDocumentIds: [{ id: 'doc-0001' }],
        actors: [],
        delegatedActors: [],
        comments: [],
        variables: {},
        taskInfo: { allowTaskReassignment: true, taskActions: [] },
      },
      opts || {},
    );
  }

  const SERIAL_ID = 'wf-serial-0001';
  const serial = {
    id: SERIAL_ID,
    label: 'Serial Document Review',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('Task375f', 'Start', 440, 0, 'ready', { isStartNode: true }),
        node('Task38e', 'Choose Participants', 420, 100, 'ready'),
        node('Task542', 'Update the Document', 620, 280, 'ready'),
        node('Task5c1', 'Stop', 420, 620, 'ready', { isEndNode: true }),
        node('Task6d8', 'Validate the Document', 240, 280, 'suspended'),
      ],
      transitions: [
        tr('Task375f', 'Task38e', 'start'),
        tr('Task38e', 'Task5c1', 'Cancelation'),
        tr('Task38e', 'Task6d8', 'Review Start', pts(180, 0, 180, 24, 0, 24, 0, 100)),
        tr('Task542', 'Task5c1', 'Cancelation', pts(200, 0, 200, 130, 0, 130, 0, 260)),
        tr('Task542', 'Task6d8', 'Document Re-Submission', pts(380, 80, 380, 103, 71, 103, 71, -30, 0, -30, 0, 0)),
        tr('Task6d8', 'Task5c1', 'End', pts(0, 0, 0, 130, 200, 130, 200, 260)),
        tr('Task6d8', 'Task6d8', 'Rejection', pts(0, 80, 0, 125, -151, 125, -151, -76, 20, -76, 20, 0)),
        tr('Task6d8', 'Task542', 'Document Update Request', pts(0, 80, 0, 123, 190, 123, 190, -30, 380, -30, 380, 0)),
        tr('Task6d8', 'Task6d8', 'Validation', pts(20, 80, 20, 164, -125, 164, -125, -30, 0, -30, 0, 0)),
      ],
    },
    workflow: workflow(
      SERIAL_ID,
      'SerialDocumentReview',
      'wf.serialDocumentReview.SerialDocumentReview',
      user('jsmith', 'John', 'Smith'),
    ),
    tasks: [
      task('task-serial-1', SERIAL_ID, 'Task6d8', 'wf.serialDocumentReview.DocumentValidation', {
        directive: 'wf.serialDocumentReview.AcceptReject',
        actors: [user('adupont', 'Alice', 'Dupont')],
        dueDate: '2026-10-30T17:00:00.000Z',
        taskInfo: {
          allowTaskReassignment: true,
          taskActions: [
            { name: 'reject', label: 'wf.serialDocumentReview.Reject', validate: true },
            { name: 'validate', label: 'wf.serialDocumentReview.Validate', validate: true },
          ],
        },
      }),
    ],
  };

  const PARALLEL_ID = 'wf-parallel-0001';
  const parallel = {
    id: PARALLEL_ID,
    label: 'Parallel Document Review',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('Task2169', 'Consolidate the Review', 360, 320, 'ready'),
        node('Task21a0', 'Start', 360, 20, 'ready', { isStartNode: true }),
        node('Task2225', 'Stop', 580, 240, 'ready', { isEndNode: true }),
        node('Task22b4', 'Stop', 580, 480, 'ready', { isEndNode: true }),
        node('Task232e', 'Stop', 160, 480, 'ready', { isEndNode: true }),
        node('Task2556', 'Choose Participants', 340, 120, 'ready'),
        node('Task328d', 'Give your Opinion', 140, 240, 'suspended', { isMultiTask: true }),
      ],
      transitions: [
        tr('Task2169', 'Task22b4', 'Validation'),
        tr('Task2169', 'Task232e', 'Rejection'),
        tr('Task21a0', 'Task2556', 'automatic_transition'),
        tr('Task2556', 'Task2225', 'Cancelation'),
        tr('Task2556', 'Task328d', 'Review start'),
        tr('Task328d', 'Task2169', 'automatic'),
      ],
    },
    workflow: workflow(
      PARALLEL_ID,
      'ParallelDocumentReview',
      'wf.parallelDocumentReview.ParallelDocumentReview',
      user('jsmith', 'John', 'Smith'),
    ),
    tasks: ['adupont:Alice:Dupont', 'bmartin:Bob:Martin', 'cnguyen:Chloe:Nguyen'].map((s, i) => {
      const [id, first, last] = s.split(':');
      return task(`task-parallel-${i}`, PARALLEL_ID, 'Task328d', 'wf.parallelDocumentReview.give_opinion.title', {
        directive: 'wf.parallelDocumentReview.give_opinion.directive',
        actors: [user(id, first, last)],
        dueDate: '2026-12-01T17:00:00.000Z',
        taskInfo: {
          allowTaskReassignment: false,
          taskActions: [
            { name: 'reject', label: 'wf.parallelDocumentReview.reject', validate: true },
            { name: 'approve', label: 'wf.parallelDocumentReview.approve', validate: true },
          ],
        },
      });
    }),
  };

  const MAIN_ID = 'wf-main-0001';
  const subWorkflow = {
    id: MAIN_ID,
    label: 'MainWF (sub-workflow)',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('Task18b2', 'Approve', 300, 380, 'ready'),
        node('Task9b9', 'ChildWF', 220, 160, 'suspended', { hasSubWorkflow: true }),
        node('start-node', 'Start', 200, 50, 'ready', { isStartNode: true }),
        node('stop-node', 'Stop', 200, 540, 'ready', { isEndNode: true }),
      ],
      transitions: [
        tr('Task18b2', 'stop-node', 'approve', pts(120, 0, 120, 40, 0, 40, 0, 50)),
        tr('Task9b9', 'stop-node', 'transition', pts(20, 0, 20, 150, 0, 150, 0, 270)),
        tr('Task9b9', 'Task18b2', 'transition2', pts(0, 0, 0, 70, 80, 70, 80, 110)),
        tr('start-node', 'Task9b9', 'automatic_transition'),
      ],
    },
    workflow: workflow(MAIN_ID, 'MainWF', 'MainWF', 'jsmith'),
    tasks: [],
  };

  const CONTRACT_ID = 'wf-contract-0001';
  const contract = {
    id: CONTRACT_ID,
    label: 'Contract Approval (synthetic)',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('n-start', 'Start', 300, 0, 'ready', { isStartNode: true }),
        node('n-prepare', 'Prepare the contract', 280, 100, 'ready'),
        node('n-fork', 'Parallel reviews', 300, 200, 'ready', { isForkNode: true }),
        node(
          'n-legal',
          'Check compliance with the regional data-protection regulations and the internal policies',
          100,
          300,
          'suspended',
        ),
        node('n-finance', 'Finance review', 500, 300, 'ready'),
        node('n-merge', 'Reviews completed', 300, 400, 'waiting', { isMerge: true }),
        node('n-decision', 'Decision', 300, 500, 'ready'),
        node('n-board', 'Board approval', 560, 520, 'ready', { hasSubWorkflow: true }),
        node('n-sign', 'Collect the signatures', 300, 620, 'ready', { isMultiTask: true }),
        node('n-archive', 'Archive', 300, 720, 'ready'),
        node('n-stop', 'Stop', 300, 820, 'ready', { isEndNode: true }),
        node('n-stop-rejected', 'Rejected', 40, 620, 'ready', { isEndNode: true }),
      ],
      transitions: [
        tr('n-start', 'n-prepare', 'automatic_transition'),
        tr('n-prepare', 'n-fork', 'Submit'),
        tr('n-fork', 'n-legal', 'Legal'),
        tr('n-fork', 'n-finance', 'Finance'),
        tr('n-legal', 'n-merge', 'Compliant'),
        tr('n-legal', 'n-prepare', 'Changes requested'),
        tr('n-finance', 'n-merge', 'Approved'),
        tr('n-finance', 'n-merge', 'Approved with reservations'),
        tr('n-merge', 'n-decision', ''),
        tr('n-decision', 'n-sign', 'Approve'),
        tr('n-decision', 'n-board', 'Amount above the delegation threshold'),
        tr('n-decision', 'n-stop-rejected', 'Reject'),
        tr('n-decision', 'n-prepare', 'Rework'),
        tr('n-board', 'n-sign', 'Board approved'),
        tr('n-board', 'n-stop-rejected', 'Board rejected'),
        tr('n-sign', 'n-sign', 'Reminder'),
        tr('n-sign', 'n-archive', 'All signed'),
        tr('n-archive', 'n-stop', ''),
      ],
    },
    workflow: workflow(CONTRACT_ID, 'ContractApproval', 'Contract Approval', user('jsmith', 'John', 'Smith')),
    tasks: [
      task('task-contract-legal', CONTRACT_ID, 'n-legal', 'Legal review', {
        directive: 'Check that the contract complies with the regulations. Use the comments to explain.',
        actors: [group('legal-team', 'Legal team'), user('emoreau', 'Emma', 'Moreau')],
        delegatedActors: [user('lgarcia', 'Lucas', 'Garcia')],
        dueDate: '2099-01-15T17:00:00.000Z',
        taskInfo: {
          allowTaskReassignment: true,
          taskActions: [
            { name: 'compliant', label: 'Compliant', validate: true },
            { name: 'changes', label: 'Request changes', validate: true },
          ],
        },
      }),
    ],
  };

  const samples = { serial, parallel, subWorkflow, contract };

  root.CWG_SAMPLES = samples;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = samples;
  }
})(typeof window !== 'undefined' ? window : globalThis);
