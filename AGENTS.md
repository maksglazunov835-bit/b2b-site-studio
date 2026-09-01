# Project Workflow Rules

- Write and edit the project code locally in this workspace.
- Keep the full project synchronized with GitHub.
- Use a private GitHub repository unless the user explicitly asks otherwise.
- Deploy and run the production build on the Timeweb server.
- Run the server deployment in a dedicated Docker container.
- Configure autodeploy so a push to GitHub can update the Timeweb server without manually copying files.
- Prefer SSH keys over passwords for server access.
- Do not ask the user for root passwords when key-based access is already available.
