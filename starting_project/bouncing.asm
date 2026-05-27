; Bouncing Ball Demo — 弹跳方块动画
; 在屏幕上显示一个来回弹跳的方块

INCLUDE "hardware.inc"

SECTION "Header", ROM0[$100]
    jp EntryPoint
    ds $150 - @, 0

EntryPoint:
    ; 关闭音频
    xor a
    ldh [rAUDENA], a

.wait_vblank
    ldh a, [rLY]
    cp LY_VBLANK
    jr c, .wait_vblank

    ; 关闭 LCD
    ld a, LCDC_OFF
    ldh [rLCDC], a

    ; ========================================
    ; 将 sprite 数据复制到 VRAM 的 tile 区域
    ; 使用 $8000 起始（sprite tile 从 $00 开始）
    ; ========================================
    ld de, BallTile
    ld hl, $8000
    ld bc, BallTile.end - BallTile
    call Copy

    ; ========================================
    ; 初始化 OAM（Object Attribute Memory）
    ; 填充到 $FE00（OAM）并清零
    ; ========================================
    ld hl, $FE00
    ld bc, 40 * 4       ; 40 个 sprite × 4 字节
    xor a
.clear_oam
    ld [hli], a
    dec bc
    ld a, b
    or a, c
    jr nz, .clear_oam

    ; 设置调色板
    ld a, %11_10_01_00
    ldh [rBGP], a
    ldh [rOBP0], a

    ; 启用 LCD + sprite
    ld a, LCDC_ON | LCDC_OBJ_ON | LCDC_OBJ_SIZE
    ldh [rLCDC], a

    ; ========================================
    ; 主循环
    ; ========================================
    ; 初始位置
    ld a, 40
    ld [ball_x], a
    ld a, 40
    ld [ball_y], a
    ld a, 1
    ld [ball_dx], a
    ld a, 1
    ld [ball_dy], a

MainLoop:
    ; 等待 VBlank
.wait
    ldh a, [rLY]
    cp LY_VBLANK
    jr c, .wait

    ; 更新位置
    ld a, [ball_x]
    ld b, a
    ld a, [ball_dx]
    add a, b
    ld [ball_x], a

    ld a, [ball_y]
    ld b, a
    ld a, [ball_dy]
    add a, b
    ld [ball_y], a

    ; 碰撞检测 X
    ; 屏幕宽 160，sprite 是 8×8，边界 0 和 152
    ld a, [ball_x]
    cp 152
    jr c, .check_x_min
    ; 碰到右边界，反转 X 方向
    ld a, -1
    ld [ball_dx], a
    jr .update_y_check

.check_x_min
    ld a, [ball_x]
    cp 8
    jr nc, .update_y_check
    ld a, 1
    ld [ball_dx], a

.update_y_check
    ; 碰撞检测 Y
    ; 屏幕高 144，sprite 是 8×8，边界 16 和 136
    ld a, [ball_y]
    cp 136
    jr c, .check_y_min
    ld a, -1
    ld [ball_dy], a
    jr .update_oam

.check_y_min
    ld a, [ball_y]
    cp 16
    jr nc, .update_oam
    ld a, 1
    ld [ball_dy], a

.update_oam
    ; 更新 OAM — sprite 0
    ld hl, $FE00
    ld a, [ball_y]
    ld [hli], a          ; Y 坐标
    ld a, [ball_x]
    ld [hli], a          ; X 坐标
    ld a, 0              ; Tile 编号
    ld [hli], a
    xor a                ; 属性 = 0
    ld [hli], a

    jp MainLoop

; ========================================
; 复制子程序：bc 字节从 de 到 hl
; ========================================
Copy:
    ld a, [de]
    ld [hli], a
    inc de
    dec bc
    ld a, b
    or a, c
    jr nz, Copy
    ret

SECTION "Variables", WRAM0
ball_x:  ds 1
ball_y:  ds 1
ball_dx: ds 1
ball_dy: ds 1

SECTION "Tile data", ROM0
BallTile:
    ; 8×8 的实心方块（白色外框 + 深色内部）
    dw `11111111
    dw `10000001
    dw `10000001
    dw `10000001
    dw `10000001
    dw `10000001
    dw `10000001
    dw `11111111
.end