//! 部署 / 还原共用的「原件计划」（P1-7 的只读一半）。
//!
//! 三个业务各写过一遍同一套流程（读记录 → 备原件 → 写新文件 → 校验 → 失败回滚）：
//! `deploy.rs`（帧生成）、`sm.rs`（解锁组件）、`dlss5.rs`。
//!
//! 这里先抽**完全不碰写入**的那一半：
//!
//!   * [`capture`]：改动之前，把目标目录里现有的原件读进内存（部署侧的「备原件」）；
//!   * [`load_originals`]：还原之前，把备份目录里的原件读回来**并校验哈希**（还原 / 回滚侧）。
//!
//! 两边产出同一个 [`BackupPlan`]，下一步的 `apply` / `rollback` 直接吃它。
//!
//! 为什么分两步：回滚写错会让用户**丢原件**（备份里有的是游戏唯一的原始文件）。
//! 所以先落地不写盘的这一半、用单测把边界钉住，再去替换三处写入路径。
//! **本文件里的函数一个字节都不改磁盘。**

use anyhow::{bail, Context, Result};
use std::path::Path;

use crate::util;

/// 一条计划项：`(相对路径, 改动前是否存在, 改动前的字节)`。
///
/// `existed_before == false` 时 `bytes` 必须为空 —— 那个位置本来什么都没有，
/// 回滚时应当把文件删掉，而不是写回 0 字节的假原件。
pub type PlanEntry = (String, bool, Vec<u8>);

/// 一次部署 / 还原「会动到哪些文件、它们原来是什么样」。
///
/// 语义是**改动之前**的状态，不是要写进去的新内容：
/// 有了它，任何一步失败都能照着它把目录恢复成动手前的样子。
#[derive(Debug, Clone, Default)]
pub struct BackupPlan {
    pub entries: Vec<PlanEntry>,
}

impl BackupPlan {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// 记一条。`existed_before == false` 时传空 `bytes`（回滚删文件即可）。
    pub fn push(&mut self, rel: impl Into<String>, existed_before: bool, bytes: Vec<u8>) {
        self.entries.push((rel.into(), existed_before, bytes));
    }

    /// 回滚时要**写回**的条目（原本就存在的那几份）。
    pub fn existing(&self) -> impl Iterator<Item = &PlanEntry> {
        self.entries.iter().filter(|e| e.1)
    }

    /// 回滚时要**删掉**的条目（原本不存在的，即这次新建的）。
    pub fn created(&self) -> impl Iterator<Item = &PlanEntry> {
        self.entries.iter().filter(|e| !e.1)
    }

    pub fn get(&self, rel: &str) -> Option<&PlanEntry> {
        self.entries.iter().find(|e| e.0 == rel)
    }

    /// 这一条在计划里的样子；没记过就返回 `None`（调用方据此判断「不在计划里」）。
    pub fn existed_before(&self, rel: &str) -> Option<bool> {
        self.get(rel).map(|e| e.1)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 给日志 / 错误信息用的一句话摘要。
    pub fn summary(&self) -> String {
        let existing = self.existing().count();
        format!(
            "{} 项（{} 项原件 + {} 项新建）",
            self.entries.len(),
            existing,
            self.entries.len() - existing
        )
    }
}

/// 备份文件名的统一约定：**扁平**，路径分隔符换成 `_`。
///
/// 0.4.0 的清单里有 `dlssg_sm86\backend\x.dll` 这类带子目录的条目：直接用路径拼进备份
/// 目录会变成嵌套路径，还原读回时还容易踩分隔符的坑（`\` 与 `/` 两种写法都存在）。
pub fn backup_file_name(rel: &str) -> String {
    format!("{}.bak", rel.replace(['\\', '/'], "_"))
}

/// 部署之前拍快照：把 `dir` 里这些相对路径的现有内容读进内存。
///
/// **只读**：不建目录、不改文件，目标不存在就记 `existed_before = false`。
///
/// 路径一律走 [`util::safe_join`]（清单会被篡改 / 损坏，不能让一个 JSON 决定读哪）。
pub fn capture<S: AsRef<str>>(dir: &Path, rels: &[S]) -> Result<BackupPlan> {
    let mut plan = BackupPlan::new();
    for rel in rels {
        let rel = rel.as_ref();
        let p = util::safe_join(dir, rel)?;
        if p.is_file() {
            let bytes =
                std::fs::read(&p).with_context(|| format!("备份 {}", p.display()))?;
            plan.push(rel, true, bytes);
        } else {
            plan.push(rel, false, Vec::new());
        }
    }
    Ok(plan)
}

/// 备份目录里的一条原件（三个业务的记录字段名不一样，这里只取共同的三项）。
pub struct BackupRef<'a> {
    /// 相对路径（还原到哪）。
    pub rel: &'a str,
    /// 备份目录里的文件名（[`backup_file_name`] 生成的扁平名）。
    pub backup_name: &'a str,
    /// 当初记下的原件哈希；老记录可能没有，那就只读不校验。
    pub original_sha256: Option<&'a str>,
}

/// 还原之前把原件读回来：**全部读完并校验通过才返回**。
///
/// 为什么必须先读完再动手：备份坏掉时如果已经删了一半部署文件，游戏目录就停在
/// 「我们的删了、原件也没回来」的半残状态。所以这里任何一份坏了都直接 `Err`，
/// 调用方此时**一个字都还没写**。
///
/// 返回的 `BackupPlan` 里每条都是 `existed_before = true`：
/// 记录里 `existed_before = false`（本来就没有原件）的条目不该传进来。
pub fn load_originals(files_dir: &Path, refs: &[BackupRef<'_>]) -> Result<BackupPlan> {
    let mut plan = BackupPlan::new();
    for r in refs {
        let src = files_dir.join(r.backup_name);
        let bytes = std::fs::read(&src).with_context(|| format!("读取备份 {}", src.display()))?;
        if let Some(orig) = r.original_sha256 {
            if util::sha256_hex(&bytes) != *orig {
                bail!("备份 {} 自身已损坏，中止（目录一个字都没动）", r.backup_name);
            }
        }
        plan.push(r.rel, true, bytes);
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 每个用例一个独立临时目录（`cargo test` 并行跑，名字里带纳秒）。
    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "fgm-backup-restore-{tag}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 原件进计划、缺失的记成「本来没有」；且 capture 不动磁盘。
    #[test]
    fn capture_reads_existing_and_marks_missing() {
        let dir = temp_dir("capture");
        std::fs::write(dir.join("version.dll"), b"ORIGINAL").unwrap();

        let plan = capture(&dir, &["version.dll", "nvngx_dlssg.dll"]).unwrap();

        assert_eq!(plan.len(), 2);
        assert_eq!(plan.get("version.dll").unwrap().1, true);
        assert_eq!(plan.get("version.dll").unwrap().2, b"ORIGINAL");
        assert_eq!(plan.get("nvngx_dlssg.dll").unwrap().1, false);
        assert!(plan.get("nvngx_dlssg.dll").unwrap().2.is_empty());
        // 只读：目标目录里没有多出任何文件，原件也没被改
        assert_eq!(std::fs::read(dir.join("version.dll")).unwrap(), b"ORIGINAL");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 备份读回并校验：哈希对上才进计划，对不上必须中止（此时磁盘一个字都没动）。
    #[test]
    fn load_originals_verifies_each_backup() {
        let files_dir = temp_dir("load");
        let name = backup_file_name("dlssg_sm86\\backend\\nvngx_dlssg.dll");
        assert_eq!(name, "dlssg_sm86_backend_nvngx_dlssg.dll.bak");
        std::fs::write(files_dir.join(&name), b"ORIGINAL").unwrap();
        let good = util::sha256_hex(b"ORIGINAL");

        let plan = load_originals(
            &files_dir,
            &[BackupRef {
                rel: "dlssg_sm86\\backend\\nvngx_dlssg.dll",
                backup_name: &name,
                original_sha256: Some(&good),
            }],
        )
        .unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan.get("dlssg_sm86\\backend\\nvngx_dlssg.dll").unwrap().2, b"ORIGINAL");

        let bad = load_originals(
            &files_dir,
            &[BackupRef {
                rel: "x.dll",
                backup_name: &name,
                original_sha256: Some(&util::sha256_hex(b"TAMPERED")),
            }],
        );
        let msg = format!("{:#}", bad.unwrap_err());
        assert!(msg.contains("损坏"), "错误信息应说明备份损坏：{msg}");

        std::fs::remove_dir_all(&files_dir).ok();
    }

    /// 清单里的路径越界（被篡改 / 损坏）时必须拒绝读取，不能拼出目录外的路径。
    #[test]
    fn capture_rejects_escaping_paths() {
        let dir = temp_dir("escape");
        assert!(capture(&dir, &["..\\evil.dll"]).is_err());
        assert!(capture(&dir, &["C:\\Windows\\System32\\x.dll"]).is_err());
        assert!(capture(&dir, &[""]).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
