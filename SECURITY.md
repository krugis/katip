# Security policy

**Please do not open public issues for security problems.**

Report vulnerabilities privately through GitHub's **"Report a vulnerability"** button (Security → Advisories) on this repository.

- We aim to acknowledge reports within 3 working days.
- We aim to fix critical issues within 72 hours and high-severity issues within 14 days.

In scope:

- the policy gateway;
- the console and its APIs;
- the provisioner;
- tenant isolation;
- personal-data masking;
- the default deployment configuration in `infra/`.

Out of scope: vulnerabilities in upstream LibreChat, LiteLLM, Keycloak or other third-party components. Please report those to their projects, but tell us too if Kâtip's configuration makes them worse.
