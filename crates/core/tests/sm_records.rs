//! 备份记录的存取自测（不碰驱动）。
//!
//! 写进 NVIDIA 预置 profile 的改动能不能还原，全看这份记录读得对不对：字段里有
//! 反斜杠和引号的 Windows 路径，而记录是手写 JSON（core 不依赖 serde 的序列化器）。
//! 这几条把"写出去 → 读回来一字不差"钉死在 CI 里。

use std::path::Path;
use std::sync::Mutex;

/// 数据根目录是进程级环境变量，改它的测试不能并行。
static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn records_round_trip_for_paths_with_quotes_and_chinese() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = std::env::temp_dir().join(format!(
        "fgm-sm-rec-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("建临时数据目录失败");
    std::env::set_var(framegen_core::util::DATA_DIR_ENV, &tmp);

    // 反斜杠 / 引号 / 中文都在里面：手写 JSON 最容易在这里翻车
    let game_dir = Path::new("D:\\Epic Game\\霍格沃茨之遗\\\"怪\"目录");
    let exe = "D:\\Epic Game\\HogwartsLegacy\\Phoenix\\Binaries\\Win64\\HogwartsLegacy.exe";
    let r = framegen_core::sm::test_record(
        "霍格沃茨之遗",
        exe,
        "Huogewoci",
        false,
        true,
        Some(0),
        game_dir,
    );

    // 按目录再读一遍：必须一模一样
    std::fs::create_dir_all(game_dir.parent().unwrap_or(Path::new("."))).ok();
    let again = framegen_core::sm::test_record_read(game_dir).expect("记录读不回来");
    assert_eq!(r, again, "写出去再读回来必须一字不差");
    assert_eq!(again.game, "霍格沃茨之遗");
    assert_eq!(again.exe, exe);
    assert_eq!(again.profile, "Huogewoci");
    assert!(!again.ours, "NVIDIA 预置 profile 不能被当成我们建的");
    assert!(again.had);
    assert_eq!(again.had_value, Some(0));

    // 没有这一项（had=false / had_value=None）也要能读回来
    let r2 = framegen_core::sm::test_record(
        "Counter-Strike 2",
        "E:\\SteamLibrary\\cs2.exe",
        "Counter-strike 2",
        false,
        false,
        None,
        Path::new("E:\\SteamLibrary\\cs2"),
    );
    assert!(!r2.had);
    assert_eq!(r2.had_value, None);
    let again2 = framegen_core::sm::test_record_read(Path::new("E:\\SteamLibrary\\cs2"))
        .expect("记录读不回来");
    assert_eq!(r2, again2);

    // 我们自己建的 profile 要能认出来（还原时只有这种才允许被删）
    let r3 = framegen_core::sm::test_record(
        "某个游戏",
        "C:\\game\\a.exe",
        "FrameGen Manager - 某个游戏",
        true,
        false,
        None,
        Path::new("C:\\game"),
    );
    assert!(r3.ours);

    std::env::remove_var(framegen_core::util::DATA_DIR_ENV);
    let _ = std::fs::remove_dir_all(&tmp);
}
