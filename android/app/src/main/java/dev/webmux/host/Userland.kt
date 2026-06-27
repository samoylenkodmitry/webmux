package dev.webmux.host

import android.content.Context
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.URL

/**
 * The Linux userland this app hosts: a static (Termux-built) proot plus a minimal
 * Debian rootfs extracted into app storage. Inside proot it's ordinary glibc Linux,
 * so node/tmux/webmux/node-pty and current Claude Code all run unmodified.
 *
 * proot + its loader + libtalloc + libandroid-shmem ship in the APK as native libs
 * (jniLibs) so they land in nativeLibraryDir, the one app-writable dir Android still
 * lets us execute from. The rootfs is data and downloads on first run.
 */
class Userland(private val ctx: Context) {

    val nativeLibDir: String = ctx.applicationInfo.nativeLibraryDir
    val rootfs = File(ctx.filesDir, "debian")
    private val runtimeLib = File(ctx.filesDir, "runtime/lib")
    private val tmpDir = File(ctx.filesDir, "tmp")
    private val shmDir = File(ctx.filesDir, "shm")
    private val marker = File(rootfs, ".installed")

    val proot get() = "$nativeLibDir/libproot.so"

    fun isInstalled(): Boolean = marker.exists()

    /** Delete the whole rootfs (repair / clean reinstall). Robust over app-owned files. */
    fun wipe() {
        if (rootfs.exists()) rootfs.deleteRecursively()
    }

    /** Idempotent: create the lib symlinks + scratch dirs proot needs. */
    fun prepareRuntime() {
        runtimeLib.mkdirs(); tmpDir.mkdirs(); shmDir.mkdirs()
        // proot's NEEDED soname is libtalloc.so.2; the real file ships as libtalloc.so
        // in nativeLibDir. Point a versioned symlink at it on LD_LIBRARY_PATH.
        symlink("$nativeLibDir/libtalloc.so", File(runtimeLib, "libtalloc.so.2"))
    }

    /** Download + extract the rootfs. Safe to call again (wipes a partial install). */
    fun install(url: String, log: (String) -> Unit) {
        prepareRuntime()
        log("Downloading Debian rootfs…")
        val tmpTar = File(ctx.cacheDir, "rootfs.tar.xz")
        URL(url).openStream().use { input ->
            FileOutputStream(tmpTar).use { out -> input.copyTo(out, 1 shl 16) }
        }
        log("Extracting rootfs (~15k files)…")
        if (rootfs.exists()) rootfs.deleteRecursively()
        rootfs.mkdirs()
        tmpTar.inputStream().use { extract(it, log) }
        tmpTar.delete()
        writeResolvConf()
        marker.writeText("debian bookworm\n")
        log("Rootfs ready.")
    }

    private fun extract(input: InputStream, log: (String) -> Unit) {
        TarArchiveInputStream(XZCompressorInputStream(BufferedInputStream(input))).use { tar ->
            var count = 0
            var entry = tar.nextTarEntry
            while (entry != null) {
                val name = entry.name.removePrefix("./").trimStart('/')
                if (name.isEmpty() || name == ".") { entry = tar.nextTarEntry; continue }
                val out = File(rootfs, name)
                when {
                    entry.isDirectory -> out.mkdirs()
                    entry.isSymbolicLink -> {
                        out.parentFile?.mkdirs()
                        lremove(out)
                        Os.symlink(entry.linkName, out.absolutePath)
                    }
                    entry.isLink -> { // hardlink
                        out.parentFile?.mkdirs()
                        lremove(out)
                        val target = File(rootfs, entry.linkName.removePrefix("./"))
                        try { Os.link(target.absolutePath, out.absolutePath) }
                        catch (e: Exception) { runCatching { target.copyTo(out, overwrite = true) } }
                    }
                    entry.isFile -> {
                        out.parentFile?.mkdirs()
                        FileOutputStream(out).use { tar.copyTo(it, 1 shl 16) }
                        runCatching { Os.chmod(out.absolutePath, entry.mode and 0xFFF) }
                    }
                    // char/block/fifo devices: skip — proot binds the host /dev.
                }
                count++
                if (count % 3000 == 0) log("…$count files")
                entry = tar.nextTarEntry
            }
            log("Extracted $count entries.")
        }
    }

    private fun writeResolvConf() {
        File(rootfs, "etc").mkdirs()
        // resolv.conf ships as a dangling symlink to systemd-resolved; replace it with
        // a real file or writes follow the broken link and ENOENT.
        val resolv = File(rootfs, "etc/resolv.conf")
        lremove(resolv)
        resolv.writeText("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
        val hostname = File(rootfs, "etc/hostname")
        lremove(hostname)
        hostname.writeText("phone\n")
    }

    /** Build the proot argv that enters the rootfs and runs [guestCmd] as fake-root. */
    fun prootArgv(
        guestCmd: List<String>,
        cwd: String = "/root",
        guestEnv: List<String> = emptyList(),
        link2symlink: Boolean = false,
    ): List<String> {
        val r = rootfs.absolutePath
        val a = mutableListOf(proot, "--kill-on-exit")
        // link2symlink makes apt/dpkg's hardlink ops work under proot, but it turns
        // hardlinks into symlinks-to-a-shared-file, which BREAKS Claude's hardlinked
        // native binary (its installer deletes a temp copy expecting hardlink semantics
        // and the shared file goes with it). So: ON only for the apt phase, OFF for the
        // rest. Android /data is ext4/f2fs with real hardlinks, fine for everything else.
        if (link2symlink) a.add("--link2symlink")
        a.addAll(listOf(
            "-0",
            "-r", r,
            "-w", cwd,
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-b", "/dev/urandom:/dev/random",
            "-b", "${shmDir.absolutePath}:/dev/shm",
            "/usr/bin/env", "-i",
            "HOME=/root",
            "TERM=xterm-256color",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG=C.UTF-8",
            "DEBIAN_FRONTEND=noninteractive",
            // proot fakes root (-0); Claude Code blocks --dangerously-skip-permissions
            // as root unless it believes it's sandboxed. The proot box is exactly that.
            "IS_SANDBOX=1",
        ))
        a.addAll(guestEnv)
        a.addAll(guestCmd)
        return a
    }

    fun prootEnv(): Map<String, String> = mapOf(
        "PROOT_LOADER" to "$nativeLibDir/libproot_loader.so",
        "PROOT_LOADER_32" to "$nativeLibDir/libproot_loader32.so",
        "PROOT_TMP_DIR" to tmpDir.absolutePath,
        "LD_LIBRARY_PATH" to "${runtimeLib.absolutePath}:$nativeLibDir",
        // NB: do NOT set PROOT_NO_SECCOMP — with seccomp off, proot ptrace-handles every
        // syscall and returns ENOSYS for write-family ones (mkdirat) it doesn't translate.
        // Default (seccomp on) passes them to the kernel natively, like proot-distro.
    )

    /** Start a guest command; stdout+stderr merged. Caller drains/​waits. */
    fun start(
        guestCmd: List<String>,
        cwd: String = "/root",
        guestEnv: List<String> = emptyList(),
        link2symlink: Boolean = false,
    ): Process {
        val pb = ProcessBuilder(prootArgv(guestCmd, cwd, guestEnv, link2symlink)).redirectErrorStream(true)
        pb.environment().putAll(prootEnv())
        return pb.start()
    }

    /** Run a guest command to completion, streaming each output line to [onLine]. */
    fun runStreaming(
        guestCmd: List<String>,
        cwd: String = "/root",
        guestEnv: List<String> = emptyList(),
        link2symlink: Boolean = false,
        onLine: (String) -> Unit,
    ): Int {
        val p = start(guestCmd, cwd, guestEnv, link2symlink)
        p.inputStream.bufferedReader().forEachLine(onLine)
        return p.waitFor()
    }

    /** Run a guest command to completion, streaming output to logcat under [tag]. */
    fun runLogged(guestCmd: List<String>, tag: String = "webmux", cwd: String = "/root"): Int =
        runStreaming(guestCmd, cwd) { Log.i(tag, it) }

    // --- webmux bring-up -----------------------------------------------------

    fun isBootstrapped(): Boolean = File(rootfs, "opt/.webmux-bootstrapped").exists()

    /** Force the bootstrap (apt/npm/build) to re-run without wiping the rootfs. */
    fun clearBootstrap() { File(rootfs, "opt/.webmux-bootstrapped").delete() }

    /**
     * Bootstrap in two proot passes: apt WITH --link2symlink (dpkg's hardlink ops fail
     * under proot without it), then everything else WITHOUT it (it breaks Claude's
     * native binary). Phase 1 installs the toolchain; phase 2 (bootstrap.sh) does
     * node/webmux/node-pty/claude/MCP.
     */
    fun bootstrap(onLine: (String) -> Unit): Int {
        val opt = File(rootfs, "opt").apply { mkdirs() }
        val dst = File(opt, "bootstrap.sh")
        ctx.assets.open("bootstrap.sh").use { i -> FileOutputStream(dst).use { o -> i.copyTo(o) } }
        runCatching { Os.chmod(dst.absolutePath, 0b111_101_101) } // 0755
        val aptRc = runStreaming(
            listOf("/bin/bash", "-lc", APT_PHASE), cwd = "/opt", link2symlink = true, onLine = onLine
        )
        if (aptRc != 0) return aptRc
        return runStreaming(
            listOf("/bin/bash", "/opt/bootstrap.sh"), cwd = "/opt", link2symlink = false, onLine = onLine
        )
    }

    /**
     * Launch webmux bound to [ip]:[port]; long-lived, caller drains/monitors. Seeds a
     * `claude` and a `shell` tmux session IN THE SAME proot before exec'ing node — the
     * tmux server is then a child of webmux's proot, so proot's --kill-on-exit doesn't
     * reap it (a separate short-lived proot would take the daemon down with it).
     */
    fun startWebmux(ip: String, port: Int = 8083): Process =
        start(
            listOf(
                "/bin/bash", "-lc",
                // claude's first-run onboarding wants an attached client, so run it but
                // fall back to a shell (in /root) if it exits — the session always persists.
                "tmux has-session -t claude 2>/dev/null || " +
                    "tmux new-session -d -s claude -x 110 -y 40 'cd /root; claude --dangerously-skip-permissions; exec bash -l'; " +
                    "tmux has-session -t shell 2>/dev/null || tmux new-session -d -s shell -c /root; " +
                    "cd /opt/webmux && exec node server.js"
            ),
            cwd = "/opt/webmux",
            // TAILSCALE=1 so the picker discovers the fleet via learned peers (the box
            // has no `tailscale` CLI, so webmux learns peers from whoever probes it).
            guestEnv = listOf("HOST=$ip", "PORT=$port", "WEBMUX_TAILSCALE=1"),
        )

    private fun lremove(f: File) {
        try {
            val st = Os.lstat(f.absolutePath)
            if (OsConstants.S_ISLNK(st.st_mode) || OsConstants.S_ISREG(st.st_mode)) Os.remove(f.absolutePath)
        } catch (_: Exception) { /* doesn't exist */ }
    }

    private fun symlink(target: String, link: File) {
        lremove(link)
        runCatching { Os.symlink(target, link.absolutePath) }
    }

    companion object {
        /** The phone's Tailscale IP (CGNAT 100.64.0.0/10) from the tun interface, or null. */
        fun findTailnetIp(): String? {
            return try {
                java.net.NetworkInterface.getNetworkInterfaces().toList().flatMap {
                    it.inetAddresses.toList()
                }.filterIsInstance<java.net.Inet4Address>().map { it.hostAddress ?: "" }
                    .firstOrNull { ip ->
                        val o = ip.split(".").mapNotNull { it.toIntOrNull() }
                        o.size == 4 && o[0] == 100 && o[1] in 64..127
                    }
            } catch (_: Exception) {
                null
            }
        }

        // Phase-1 of bootstrap: the apt/dpkg part, run WITH --link2symlink. Disables
        // apt's _apt sandbox (can't setresuid under proot) and installs the toolchain.
        const val APT_PHASE = """
mkdir -p /etc/apt/apt.conf.d
echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/00sandbox-off
export DEBIAN_FRONTEND=noninteractive
echo "BOOT: apt update"
apt-get update -y
echo "BOOT: apt install build tools"
apt-get install -y --no-install-recommends ca-certificates git curl xz-utils procps python3 make g++ tmux
echo "BOOT: apt done"
"""

        // Pinned rootfs the app downloads on first run. Swapped to the GitHub Release
        // mirror at publish time; overridable for local testing via BuildConfig/Intent.
        const val DEFAULT_ROOTFS_URL =
            "https://github.com/samoylenkodmitry/webmux/releases/download/userland-v1/debian-arm64-rootfs.tar.xz"
    }
}
