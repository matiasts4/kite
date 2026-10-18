//! Runs a console program attached to a *hidden* console window.
//!
//! `CREATE_NO_WINDOW` gives the child no console at all. When that child is an
//! agent CLI (for example `agy`) which in turn starts console programs (MCP
//! servers, shells, updaters), every grandchild allocates a brand new console.
//! Windows then surfaces that console as an external terminal window for a few
//! milliseconds, which is the periodic flash users see while quotas are polled
//! in the background.
//!
//! Creating the child with its own console but starting it with `SW_HIDE`
//! keeps the whole process tree attached to an invisible console, so no
//! descendant can open a visible terminal. Standard input/output/error are
//! still redirected through pipes, so callers keep capturing the program's
//! output exactly as with `Command::output()`.

use std::path::Path;
use std::time::Duration;

pub struct HiddenOutput {
    /// Exit code, or `None` when the process had to be killed after the timeout.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

impl HiddenOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

impl std::fmt::Debug for HiddenOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HiddenOutput")
            .field("code", &self.code)
            .field("stdout_len", &self.stdout.len())
            .field("stderr_len", &self.stderr.len())
            .field("timed_out", &self.timed_out)
            .finish()
    }
}

/// Runs `program` with `args` for at most `timeout`, capturing its output.
///
/// On Windows the process tree is attached to a hidden console; on every other
/// platform this degrades to a plain piped `Command`.
pub fn run(program: &Path, args: &[&str], timeout: Duration) -> std::io::Result<HiddenOutput> {
    #[cfg(windows)]
    {
        windows_impl::run(program, args, timeout)
    }
    #[cfg(not(windows))]
    {
        portable_impl::run(program, args, timeout)
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::HiddenOutput;
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::time::Duration;

    type Handle = *mut c_void;
    type Bool = i32;

    const STARTF_USESHOWWINDOW: u32 = 0x0000_0001;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const SW_HIDE: u16 = 0;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const WAIT_TIMEOUT: u32 = 0x0000_0102;
    const WAIT_INFINITE: u32 = 0xFFFF_FFFF;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;

    #[repr(C)]
    struct SecurityAttributes {
        n_length: u32,
        lp_security_descriptor: *mut c_void,
        b_inherit_handle: Bool,
    }

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: Handle,
        h_std_output: Handle,
        h_std_error: Handle,
    }

    #[repr(C)]
    struct ProcessInformation {
        h_process: Handle,
        h_thread: Handle,
        dw_process_id: u32,
        dw_thread_id: u32,
    }

    impl Default for StartupInfoW {
        fn default() -> Self {
            Self {
                cb: std::mem::size_of::<StartupInfoW>() as u32,
                lp_reserved: null_mut(),
                lp_desktop: null_mut(),
                lp_title: null_mut(),
                dw_x: 0,
                dw_y: 0,
                dw_x_size: 0,
                dw_y_size: 0,
                dw_x_count_chars: 0,
                dw_y_count_chars: 0,
                dw_fill_attribute: 0,
                dw_flags: 0,
                w_show_window: 0,
                cb_reserved2: 0,
                lp_reserved2: null_mut(),
                h_std_input: null_mut(),
                h_std_output: null_mut(),
                h_std_error: null_mut(),
            }
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreatePipe(
            read_pipe: *mut Handle,
            write_pipe: *mut Handle,
            attributes: *mut SecurityAttributes,
            size: u32,
        ) -> Bool;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> Bool;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            attributes: *mut SecurityAttributes,
            creation: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *mut SecurityAttributes,
            thread_attributes: *mut SecurityAttributes,
            inherit_handles: Bool,
            creation_flags: u32,
            environment: *mut c_void,
            current_directory: *const u16,
            startup_info: *mut StartupInfoW,
            process_information: *mut ProcessInformation,
        ) -> Bool;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> Bool;
        fn TerminateProcess(process: Handle, exit_code: u32) -> Bool;
        fn ReadFile(
            file: Handle,
            buffer: *mut u8,
            bytes: u32,
            read: *mut u32,
            overlapped: *mut c_void,
        ) -> Bool;
        fn CloseHandle(object: isize) -> Bool;
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Quotes one argument using the rules `CommandLineToArgvW` expects.
    fn quote_arg(arg: &OsStr) -> Vec<u16> {
        let text = arg.to_string_lossy();
        if !text.is_empty() && !text.contains([' ', '\t', '"']) {
            return text.encode_utf16().collect();
        }

        let mut out: Vec<u16> = Vec::with_capacity(text.len() + 2);
        out.push(b'"' as u16);
        let mut backslashes = 0usize;
        for ch in text.chars() {
            match ch {
                '\\' => backslashes += 1,
                '"' => {
                    out.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2 + 1));
                    out.push(b'"' as u16);
                    backslashes = 0;
                }
                other => {
                    if backslashes > 0 {
                        out.extend(std::iter::repeat(b'\\' as u16).take(backslashes));
                        backslashes = 0;
                    }
                    let mut buf = [0u16; 2];
                    out.extend_from_slice(other.encode_utf16(&mut buf));
                }
            }
        }
        if backslashes > 0 {
            out.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2));
        }
        out.push(b'"' as u16);
        out
    }

    fn command_line(program: &Path, args: &[&str]) -> Vec<u16> {
        let mut line = quote_arg(program.as_os_str());
        for arg in args {
            line.push(b' ' as u16);
            line.extend(quote_arg(OsStr::new(arg)));
        }
        line.push(0);
        line
    }

    fn read_pipe(handle: Handle) -> Vec<u8> {
        let mut collected = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let mut read: u32 = 0;
            let ok = unsafe {
                ReadFile(handle, buffer.as_mut_ptr(), buffer.len() as u32, &mut read, null_mut())
            };
            if ok == 0 || read == 0 {
                break;
            }
            collected.extend_from_slice(&buffer[..read as usize]);
        }
        collected
    }

    fn null_device(attributes: *mut SecurityAttributes) -> Handle {
        let name = wide(OsStr::new("NUL"));
        unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                attributes,
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        }
    }

    fn close(handle: Handle) {
        if !handle.is_null() && handle as isize != -1 {
            unsafe {
                CloseHandle(handle as isize);
            }
        }
    }

    pub(super) fn run(
        program: &Path,
        args: &[&str],
        timeout: Duration,
    ) -> io::Result<HiddenOutput> {
        unsafe {
            let mut attributes = SecurityAttributes {
                n_length: std::mem::size_of::<SecurityAttributes>() as u32,
                lp_security_descriptor: null_mut(),
                b_inherit_handle: 1,
            };

            let (mut stdout_read, mut stdout_write): (Handle, Handle) = (null_mut(), null_mut());
            let (mut stderr_read, mut stderr_write): (Handle, Handle) = (null_mut(), null_mut());
            if CreatePipe(&mut stdout_read, &mut stdout_write, &mut attributes, 0) == 0 {
                return Err(io::Error::last_os_error());
            }
            if CreatePipe(&mut stderr_read, &mut stderr_write, &mut attributes, 0) == 0 {
                close(stdout_read);
                close(stdout_write);
                return Err(io::Error::last_os_error());
            }

            // Only the write ends (handed to the child) may be inherited.
            SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);

            let stdin_handle = null_device(&mut attributes);
            if stdin_handle == null_mut() || stdin_handle as isize == -1 {
                close(stdout_read);
                close(stdout_write);
                close(stderr_read);
                close(stderr_write);
                return Err(io::Error::last_os_error());
            }

            let mut startup = StartupInfoW::default();
            startup.dw_flags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
            startup.w_show_window = SW_HIDE;
            startup.h_std_input = stdin_handle;
            startup.h_std_output = stdout_write;
            startup.h_std_error = stderr_write;

            let mut line = command_line(program, args);
            let mut process_info = ProcessInformation {
                h_process: null_mut(),
                h_thread: null_mut(),
                dw_process_id: 0,
                dw_thread_id: 0,
            };

            let created = CreateProcessW(
                null(),
                line.as_mut_ptr(),
                null_mut(),
                null_mut(),
                1,
                CREATE_NEW_CONSOLE,
                null_mut(),
                null(),
                &mut startup,
                &mut process_info,
            );

            // The parent must drop its copies of the write ends so the reader
            // threads observe EOF once the child (and every descendant) exits.
            close(stdout_write);
            close(stderr_write);
            close(stdin_handle);

            if created == 0 {
                let error = io::Error::last_os_error();
                close(stdout_read);
                close(stderr_read);
                return Err(error);
            }

            // Raw handles are plain pointers; the two reader threads own one
            // pipe each, so moving them across threads is sound.
            let stdout_handle = stdout_read as usize;
            let stderr_handle = stderr_read as usize;
            let stdout_thread = std::thread::spawn(move || read_pipe(stdout_handle as Handle));
            let stderr_thread = std::thread::spawn(move || read_pipe(stderr_handle as Handle));

            let wait_ms = timeout.as_millis().min(WAIT_INFINITE as u128) as u32;
            let waited = WaitForSingleObject(process_info.h_process, wait_ms);
            let timed_out = waited == WAIT_TIMEOUT;
            if timed_out {
                TerminateProcess(process_info.h_process, 1);
                WaitForSingleObject(process_info.h_process, WAIT_INFINITE);
            }

            let mut exit_code: u32 = 1;
            GetExitCodeProcess(process_info.h_process, &mut exit_code);

            let stdout = stdout_thread.join().unwrap_or_default();
            let stderr = stderr_thread.join().unwrap_or_default();

            close(process_info.h_thread);
            close(process_info.h_process);

            Ok(HiddenOutput {
                code: if timed_out { None } else { Some(exit_code as i32) },
                stdout,
                stderr,
                timed_out,
            })
        }
    }
}

#[cfg(not(windows))]
mod portable_impl {
    use super::HiddenOutput;
    use std::io;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    pub(super) fn run(
        program: &Path,
        args: &[&str],
        timeout: Duration,
    ) -> io::Result<HiddenOutput> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let started = Instant::now();
        let mut timed_out = false;
        loop {
            if child.try_wait()?.is_some() {
                break;
            }
            if started.elapsed() > timeout {
                let _ = child.kill();
                timed_out = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }

        let output = child.wait_with_output()?;
        Ok(HiddenOutput {
            code: if timed_out { None } else { output.status.code() },
            stdout: output.stdout,
            stderr: output.stderr,
            timed_out,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn captures_stdout_and_exit_code_without_a_visible_console() {
        let out = run(
            Path::new("cmd.exe"),
            &["/c", "echo kite-hidden-exec"],
            Duration::from_secs(10),
        )
        .expect("hidden exec should start");
        assert!(out.success(), "unexpected output: {:?}", out);
        assert!(out.stdout_lossy().contains("kite-hidden-exec"));
    }

    #[cfg(windows)]
    #[test]
    fn reports_non_zero_exit_codes() {
        let out = run(
            Path::new("cmd.exe"),
            &["/c", "exit 7"],
            Duration::from_secs(10),
        )
        .expect("hidden exec should start");
        assert_eq!(out.code, Some(7));
        assert!(!out.success());
    }

    #[cfg(windows)]
    #[test]
    fn kills_processes_that_run_past_the_timeout() {
        // No grandchildren: a lingering child would keep the inherited pipe
        // open and the reader threads would never observe EOF.
        let out = run(
            Path::new("powershell.exe"),
            &["-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
            Duration::from_millis(600),
        )
        .expect("hidden exec should start");
        assert!(out.timed_out);
        assert_eq!(out.code, None);
    }
}
