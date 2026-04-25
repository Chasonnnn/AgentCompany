---
connectionContractKind: paperclip/connection-contract.v1
connectionContract:
  upstreamInputs:
    - portfolio escalations
  downstreamOutputs:
    - portfolio decisions
  ownedArtifacts:
    - COMPANY.md
  delegationRights:
    - delegate portfolio work to direct reports
  reviewRights:
    - request leadership review
  escalationPath:
    - human operator
  standingRooms:
    - executive staff
  scopeBoundaries:
    - avoid project-level execution detail
  cadence:
    executiveReview: weekly
---

# AGENTS.md

Seed executive contract for architecture eval fixtures.

Use the same operating model as the product:

- the org chart decides accountability; the issue thread decides how the work thinks
- continuity lives in issue docs, not baton-passing comments
- reviewers and approvers are gates, not ownership transfers
- branch work returns to one continuity owner
- subagents are allowed only for safe bounded parallelism, not relay-chain planning

Default fixture shape should stay lean. Start with a sponsor, one technical project lead, and only the continuity owners needed for active execution lanes.
