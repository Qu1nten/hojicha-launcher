<p align="center">
  <img src="build/icon.png" width="128" alt="Hojicha Launcher logo: a pixel-art cup of hojicha">
</p>

<h1 align="center">Hojicha Launcher</h1>

<p align="center">
  A small, open-source Minecraft: Java Edition launcher for Windows (and, unofficially, macOS).
</p>

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

![Hojicha Launcher showing an instance's mods, resource packs and shaders](docs/screenshot-mods.png)

## Features

- **Instances** — vanilla or Fabric, any version, each with its own mods and worlds
- **Installed** — mods, resource packs and shaders in one list; toggle or update in one click
- **Modrinth** — browse and install mods, packs, shaders and modpacks
- **Syncing** — share worlds, settings and packs between instances
- **Servers** — run a Paper, Purpur or Fabric server; friends join over the internet via [playit.gg](https://playit.gg) without port forwarding
- **Skins and capes** — change your skin and cape with a 3D preview; saved skins carry across accounts
- **Schematics** — view Litematica, WorldEdit and Axiom files (.litematic, .schem, .schematic, .bp) in 3D, grouped and sorted
- **Two themes** — dark **Hojicha** and light **Matcha**
- **Sign-in on Microsoft's website** — Hojicha never sees your password; tokens are stored encrypted on your PC

## Install

Download the installer from the [Releases](../../releases) page. Windows SmartScreen may warn on first run since the installer isn't code-signed — click **More info → Run anyway**. The launcher installs to `%LOCALAPPDATA%\Programs\Hojicha Launcher` by default and updates itself automatically.

To uninstall, run `uninstall.exe` in the launcher folder or use **Settings → Apps**. This deletes the entire folder, **including your instances and worlds**, so back up anything you want to keep first.

### macOS

There's no Mac installer, but you can run the launcher from its source code:

1. Install [Node.js](https://nodejs.org) (the LTS version) and Git (run `xcode-select --install` in Terminal).
2. In Terminal, download the launcher and its parts:
   ```
   git clone https://github.com/Qu1nten/hojicha-launcher.git
   cd hojicha-launcher
   npm install
   ```
3. Start it with `npm start` (from the `hojicha-launcher` folder). To update, run `git pull` and `npm install`, then `npm start` again.

Your instances, worlds and settings are saved in the `dev-home` folder inside `hojicha-launcher`, so don't delete that folder.

Mac support is unofficial. What doesn't work on a Mac:

- **Online play** through playit.gg (hosting a server works, but only your own Mac can join it; you can still join a friend's online server)
- **Borderless fullscreen**
- **Old Minecraft versions** (before 1.13) may not start on Apple Silicon Macs
- **Automatic updates**: update with `git pull` and `npm install` instead
- Closing the launcher doesn't close a running game

## License

[MIT](LICENSE). Bundled libraries: [Zen Kaku Gothic New](src/renderer/fonts/OFL.txt) (SIL OFL 1.1), [skinview3d](src/renderer/vendor/skinview3d-LICENSE.txt) (MIT), [deepslate](src/renderer/vendor/deepslate-LICENSE.txt) (MIT). playit.gg's agent is downloaded from its official releases and is not part of this repository. Minecraft is a trademark of Mojang Synergies AB.
