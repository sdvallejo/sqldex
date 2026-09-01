use std::{env, fs};

use zed_extension_api::{
    self as zed, settings::LspSettings, Command, LanguageServerId, Result, Worktree,
};

const SERVER_NAME: &str = "sqldex-lsp";
const SERVER_PACKAGE: &str = "@sqldex/lsp";
const SERVER_PACKAGE_PATH: &str = "node_modules/@sqldex/lsp/dist/main.js";
const DEFAULT_ARGS: &[&str] = &["--stdio"];

struct SqldexExtension {
    did_find_server: bool,
}

impl SqldexExtension {
    fn server_package_exists(&self) -> bool {
        fs::metadata(SERVER_PACKAGE_PATH).is_ok_and(|stat| stat.is_file())
    }

    /// The last resort: no server was named and none is installed, so fetch one. Kept to the
    /// version npm currently calls latest, which is what carries a new rule to a machine that has
    /// nothing of its own to update.
    fn install_server(&mut self, id: &LanguageServerId) -> Result<String> {
        let server_exists = self.server_package_exists();
        if self.did_find_server && server_exists {
            return Ok(SERVER_PACKAGE_PATH.to_string());
        }

        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let version = zed::npm_package_latest_version(SERVER_PACKAGE)?;

        if !server_exists
            || zed::npm_package_installed_version(SERVER_PACKAGE)?.as_ref() != Some(&version)
        {
            zed::set_language_server_installation_status(
                id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            // An install that fails over a copy already on disk is survivable — that copy still
            // starts, just older. One that leaves nothing behind is not, and saying so here beats
            // letting Node fail later over a path that was never written.
            match zed::npm_install_package(SERVER_PACKAGE, &version) {
                Ok(()) if !self.server_package_exists() => Err(format!(
                    "installed {SERVER_PACKAGE} has no {SERVER_PACKAGE_PATH}"
                ))?,
                Err(error) if !self.server_package_exists() => Err(error)?,
                _ => {}
            }
        }

        self.did_find_server = true;
        Ok(SERVER_PACKAGE_PATH.to_string())
    }

    fn default_args() -> Vec<String> {
        DEFAULT_ARGS.iter().map(|arg| arg.to_string()).collect()
    }
}

impl zed::Extension for SqldexExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        // A user-configured binary path (the equivalent of the VS Code/Neovim clients'
        // `sqldex.server.path`) wins over everything else.
        let configured = LspSettings::for_worktree(SERVER_NAME, worktree)
            .ok()
            .and_then(|settings| settings.binary);
        if let Some(path) = configured.as_ref().and_then(|binary| binary.path.clone()) {
            let args = configured
                .as_ref()
                .and_then(|binary| binary.arguments.clone())
                .unwrap_or_else(Self::default_args);
            let env = configured
                .and_then(|binary| binary.env)
                .map(|env| env.into_iter().collect())
                .unwrap_or_else(|| worktree.shell_env());
            return Ok(Command {
                command: path,
                args,
                env,
            });
        }

        if let Some(path) = worktree.which(SERVER_NAME) {
            return Ok(Command {
                command: path,
                args: Self::default_args(),
                env: worktree.shell_env(),
            });
        }

        let server_path = self.install_server(id)?;
        let mut args = vec![env::current_dir()
            .unwrap()
            .join(&server_path)
            .to_string_lossy()
            .to_string()];
        args.extend(Self::default_args());
        Ok(Command {
            command: zed::node_binary_path()?,
            args,
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(SqldexExtension);
