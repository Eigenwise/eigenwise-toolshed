---
title: Windows Sandbox clean room
description: Try the published marketplace from a fresh, disposable Windows profile.
---

Use Windows Sandbox when you want to experience the public Eigenwise Toolshed marketplace the way a new Windows customer does. It starts a disposable Windows VM, installs native Claude Code, and leaves marketplace setup and authentication to you.

## Launch it

From a Toolshed checkout in PowerShell:

```powershell
.\sandbox\windows\Start-ToolshedSandbox.ps1
```

The launcher writes a temporary `.wsb` file, then opens Windows Sandbox. It needs the optional Windows Sandbox feature. When that feature is missing, the launcher prints this one-time command instead of enabling or restarting anything itself:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' -All -NoRestart
```

Run it in an elevated PowerShell, restart Windows yourself, then launch again. Check the generated configuration without opening Sandbox:

```powershell
.\sandbox\windows\Start-ToolshedSandbox.ps1 -GenerateOnly
```

## What happens in the guest

The guest runs Anthropic's official native Windows installer:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Keep the installer window open so you can see its output. After a successful install, the guest opens a new PowerShell in an empty workspace and opens this getting-started site. Authenticate Claude Code yourself, then follow the normal public marketplace flow. The harness does not install Git, Node, npm, Eigenwise Toolshed, a marketplace, or any plugin. Missing prerequisites are part of the check.

## What stays isolated

Only `sandbox/windows/bootstrap` is mounted into the guest, and it is read-only. The repository root, your Windows profile, `.claude` directory, SSH keys, Git credentials, and browser profiles are never mounted.

Networking stays on for the installer, authentication, public docs, and marketplace access. vGPU, microphone, camera, and printer redirection are off. Clipboard redirection is also off deliberately, so host clipboard contents cannot drift into the clean-room. Type the public marketplace commands in the guest or use the opened docs page.

Closing the Sandbox window tears down the VM and its local state. Start a new Sandbox for the next clean run.

## Marketplace acceptance checklist

Work through this in the guest after signing in:

1. Add the public Eigenwise Toolshed marketplace.
2. Install the plugin you are checking.
3. Run its first useful command or skill.
4. Update the plugin, then confirm the updated version works after the required reload.
5. Uninstall it and install it again.
6. Run Claude Code's doctor command and check the plugin reports cleanly.

Keep authentication and marketplace acceptance manual. The point is to catch the real fresh-machine path, not to script around it.
