# Security

agent-flows runs at build time. It turns flow definitions into markdown and writes files only where its caller asks. The skills it generates are instructions that an agent later executes, so a malicious flow definition can produce harmful skills. Review flows from untrusted sources the way you would review code.

To report a vulnerability, use [GitHub private vulnerability reporting](https://github.com/Project-White-Rabbit/agent-flows/security/advisories/new) rather than a public issue.
