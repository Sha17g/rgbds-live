; Horizontal Scroller Demo — 水平滚动彩条动画
; 使用 LCDC BG 滚动功能实现彩色条纹的连续移动

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
    ; 将 tile 数据复制到 VRAM
    ; tile 0: 空白
    ; tile 1-4: 竖条纹图案（不同位置的黑白竖线）
    ; ========================================
    ld de, Tiles
    ld hl, STARTOF(VRAM)
    ld bc, Tiles.end - Tiles
    call Copy

    ; ========================================
    ; 构建背景 tile map
    ; 用不同 tile 填充背景以形成彩色条纹
    ; ========================================
    ld hl, TILEMAP0
    ld d, 18             ; 18 行
.row_loop
    ld e, 32             ; 每行 32 列
.col_loop
    ; 根据列号选择不同 tile 形成条纹
    ld a, 32
    sub a, e             ; a = 列号 (0-31)
    and a, %00000011     ; 取低2位决定 tile 0-3
    add a, 1             ; tile 1-4（跳过空白 tile 0）
    ld [hli], a
    dec e
    jr nz, .col_loop
    dec d
    jr nz, .row_loop

    ; ========================================
    ; 设置调色板 — 4 种灰度级别
    ; ========================================
    ld a, %11_10_01_00
    ldh [rBGP], a

    ; 启用 LCD + BG
    ld a, LCDC_ON | LCDC_BG_ON
    ldh [rLCDC], a

    ; ========================================
    ; 主循环 — 不断改变 SCX 实现水平滚动
    ; ========================================
    ld a, 0
    ld [scroll_x], a

MainLoop:
    ; 等待 VBlank（确保不撕裂画面）
.wait
    ldh a, [rLY]
    cp LY_VBLANK
    jr c, .wait

    ; 更新 SCX
    ld a, [scroll_x]
    ldh [rSCX], a
    add a, 1             ; 缓慢滚动
    ld [scroll_x], a

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
scroll_x: ds 1

SECTION "Tile data", ROM0
Tiles:
    ; Tile 0: 全空白
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000

    ; Tile 1: 左侧白竖条（宽2px白 + 黑）
    dw `11000000
    dw `11000000
    dw `11000000
    dw `11000000
    dw `11000000
    dw `11000000
    dw `11000000
    dw `11000000

    ; Tile 2: 左侧灰竖条（宽2px浅灰 + 黑）
    dw `00110000
    dw `00110000
    dw `00110000
    dw `00110000
    dw `00110000
    dw `00110000
    dw `00110000
    dw `00110000

    ; Tile 3: 右侧灰竖条（宽2px深灰 + 黑）
    dw `00001100
    dw `00001100
    dw `00001100
    dw `00001100
    dw `00001100
    dw `00001100
    dw `00001100
    dw `00001100

    ; Tile 4: 右侧白竖条（宽2px最白 + 黑）
    dw `00000011
    dw `00000011
    dw `00000011
    dw `00000011
    dw `00000011
    dw `00000011
    dw `00000011
    dw `00000011
.end