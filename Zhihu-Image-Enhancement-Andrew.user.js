// ==UserScript==
// @name         知乎图片增强 - 最终版（排除头像/GIF，可设置）
// @namespace    https://github.com/yourname
// @version      2.5
// @downloadURL  https://raw.githubusercontent.com/andrew05060414/UserScript/andrew-main/Zhihu-Image-Enhancement-Andrew.user.js
// @updateURL    https://raw.githubusercontent.com/andrew05060414/UserScript/andrew-main/Zhihu-Image-Enhancement-Andrew.user.js
// @description  知乎图片增强：正文图片和 GIF/视频预览、滚轮缩放、拖拽、旋转、切换
// @author       Andrew Wang
// @match        *://www.zhihu.com/*
// @match        *://zhuanlan.zhihu.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    // ======================= 默认设置 =======================
    const defaultSettings = {
        enableRotateBtn: true,
        enablePrevNextBtn: true,
        enableKeyboard: true,
        enableCounter: true,
        enableDrag: true,
        enableZoom: true,
        excludeGif: false           // 默认接管 GIF；开启后保留知乎原生播放
    };

    let settings = {};
    function loadSettings() {
        for (let key in defaultSettings) {
            let val = GM_getValue(key, defaultSettings[key]);
            settings[key] = val;
        }
    }
    function saveSetting(key, value) {
        GM_setValue(key, value);
        settings[key] = value;
    }
    loadSettings();
    GM_registerMenuCommand('⚙️ 图片增强设置', openSettingsPanel);

    // ======================= 全局变量 =======================
    let overlay = null;
    let imgContainer = null;
    let mediaElement = null;
    let scale = 1, translateX = 0, translateY = 0;
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let lastTranslateX = 0, lastTranslateY = 0;
    let rotateDeg = 0;
    let imageList = [];
    let currentIndex = -1;
    let prevBtn = null, nextBtn = null, rotateBtn = null, counterSpan = null;

    // ======================= 工具函数 =======================
    function getRealImageUrl(img) {
        return img.getAttribute('data-original') ||
               img.getAttribute('data-actualsrc') ||
               img.currentSrc ||
               img.src;
    }

    function isGifLike(img) {
        const source = [img.src, img.getAttribute('data-original'), img.getAttribute('data-actualsrc')]
            .filter(Boolean).join(' ').toLowerCase();
        return img.closest('.GifPlayer') ||
               img.classList.contains('ztext-gif') ||
               source.includes('.gif') || source.includes('gif2mp4');
    }

    function getMediaInfo(img) {
        const gifPlayer = img.closest('.GifPlayer');
        const video = gifPlayer?.querySelector('video');
        const videoUrl = video?.currentSrc || video?.src || video?.querySelector('source')?.src;
        if (videoUrl) return { type: 'video', url: videoUrl };

        // 知乎未播放的 GIF 只有 JPG 封面，不可把它误当作动图放大。
        // 留给知乎原生播放器取得真实视频源；播放后再次点击即可接管 video。
        if (gifPlayer) return null;

        const url = getRealImageUrl(img);
        return url ? { type: 'image', url } : null;
    }

    function isContentImage(img) {
        return Boolean(img.closest('.RichContent, .Post-content, .ztext, .AnswerItem, .QuestionAnswer-content'));
    }

    function isLinkedImage(img) {
        const link = img.closest('a[href]');
        const href = link?.getAttribute('href');
        return Boolean(href && href !== '#' && !href.startsWith('javascript:'));
    }

    // 判断图片是否应该由本脚本处理（仅正文图片；排除头像、小图标和跳转图片）
    function shouldHandleImage(img) {
        if (!img || !isContentImage(img) || isLinkedImage(img)) return false;

        // 0. 用户可选择保留 GIF 的知乎原生播放。
        if (settings.excludeGif && isGifLike(img)) {
            return false;
        }

        // 1. 排除 class 包含头像/图标关键词
        const imgClass = (img.className || '').toLowerCase();
        const excludeClasses = ['avatar', 'user-avatar', 'profileavatar', 'useravatar', 'icon', 'emoji', 'button', 'logo'];
        for (let cls of excludeClasses) {
            if (imgClass.includes(cls)) return false;
        }

        // 2. 检查父元素是否有头像容器
        let parent = img.parentElement;
        let depth = 0;
        while (parent && depth < 5) {
            const parentClass = (parent.className || '').toLowerCase();
            if (parentClass.includes('avatar') || parentClass.includes('user-avatar') || parentClass === 'avatar') {
                return false;
            }
            parent = parent.parentElement;
            depth++;
        }

        // 3. 排除 URL 中明确的头像/图标资源。避免把普通图片 URL 中的 user/profile 误杀。
        const url = (getRealImageUrl(img) || '').toLowerCase();
        const urlExcludes = ['avatar', 'icon', 'emoji', 'static.zhimg.com/avatar'];
        for (let kw of urlExcludes) {
            if (url.includes(kw)) return false;
        }

        // 4. 没有真实媒体源（尤其是未播放的知乎 GIF）时不接管。
        if (!getMediaInfo(img)) return false;

        // 5. 尺寸过滤：宽或高小于 50px 的排除（头像/图标）
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if ((width > 0 && width < 50) || (height > 0 && height < 50)) return false;

        // 6. 小尺寸 GIF 通常是表情，不打开查看器。
        if (!settings.excludeGif && isGifLike(img) && ((width > 0 && width < 100) || (height > 0 && height < 100))) {
            return false;
        }

        return true;
    }

    function collectImagesInSameContext(clickedImg) {
        const container = clickedImg.closest('.RichContent, .Post-content, .ztext, .AnswerItem, .QuestionAnswer-content');
        if (!container) return [];
        const allImgs = container.querySelectorAll('img');
        let media = [];
        const seen = new Set();
        allImgs.forEach(img => {
            if (shouldHandleImage(img)) {
                const item = getMediaInfo(img);
                const key = item && `${item.type}\u0000${item.url}`;
                if (key && !seen.has(key)) {
                    seen.add(key);
                    media.push(item);
                }
            }
        });
        return media;
    }

    function resetTransform() {
        scale = 1;
        translateX = 0;
        translateY = 0;
        rotateDeg = 0;
        updateTransform();
        if (mediaElement) mediaElement.style.transform = `rotate(${rotateDeg}deg)`;
    }

    function updateTransform() {
        if (!imgContainer) return;
        imgContainer.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }

    function rotateImage(deltaDeg) {
        if (!settings.enableRotateBtn && !settings.enableKeyboard) return;
        rotateDeg = (rotateDeg + deltaDeg) % 360;
        if (mediaElement) mediaElement.style.transform = `rotate(${rotateDeg}deg)`;
        scale = 1;
        translateX = 0;
        translateY = 0;
        updateTransform();
    }

    function switchImage(delta) {
        if (!settings.enablePrevNextBtn && !settings.enableKeyboard) return;
        if (!imageList.length) return;
        let newIndex = currentIndex + delta;
        if (newIndex < 0) newIndex = imageList.length - 1;
        if (newIndex >= imageList.length) newIndex = 0;
        if (newIndex === currentIndex) return;
        currentIndex = newIndex;
        resetTransform();
        renderMedia(imageList[currentIndex]);
        if (counterSpan && settings.enableCounter) {
            counterSpan.textContent = `${currentIndex+1} / ${imageList.length}`;
        }
    }

    function zoom(delta, clientX, clientY) {
        if (!settings.enableZoom) return;
        if (!imgContainer || !mediaElement) return;
        const oldScale = scale;
        let newScale = scale + delta * 0.1;
        newScale = Math.min(5, Math.max(0.3, newScale));
        if (newScale === oldScale) return;

        const rect = imgContainer.getBoundingClientRect();
        const mouseX = clientX - rect.left;
        const mouseY = clientY - rect.top;
        const ratioX = mouseX / rect.width;
        const ratioY = mouseY / rect.height;

        scale = newScale;
        const newRect = imgContainer.getBoundingClientRect();
        const newMouseX = clientX - newRect.left;
        const newMouseY = clientY - newRect.top;
        translateX += (newMouseX - mouseX);
        translateY += (newMouseY - mouseY);
        updateTransform();
    }

    // ======================= SVG 图标 =======================
    const svgPrev = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
    const svgNext = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    const svgRotate = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path></svg>`;

    // ======================= UI 创建 =======================
    function createControlBar() {
        const bar = document.createElement('div');
        bar.id = 'zh-img-control-bar';
        bar.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 8px;
            background: rgba(0,0,0,0.6);
            backdrop-filter: blur(8px);
            padding: 6px 12px;
            border-radius: 40px;
            z-index: 1000000;
            pointer-events: auto;
        `;
        const btnStyle = `
            background: rgba(255,255,255,0.15);
            border: none;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            color: white;
            transition: all 0.2s ease;
        `;
        const btnHover = `background: rgba(255,255,255,0.3); transform: scale(1.05);`;

        if (settings.enablePrevNextBtn) {
            prevBtn = document.createElement('button');
            prevBtn.innerHTML = svgPrev;
            prevBtn.title = '上一张 (←)';
            prevBtn.style.cssText = btnStyle;
            prevBtn.onmouseenter = () => prevBtn.style.cssText += btnHover;
            prevBtn.onmouseleave = () => prevBtn.style.cssText = btnStyle;
            prevBtn.onclick = () => switchImage(-1);
            bar.appendChild(prevBtn);

            nextBtn = document.createElement('button');
            nextBtn.innerHTML = svgNext;
            nextBtn.title = '下一张 (→)';
            nextBtn.style.cssText = btnStyle;
            nextBtn.onmouseenter = () => nextBtn.style.cssText += btnHover;
            nextBtn.onmouseleave = () => nextBtn.style.cssText = btnStyle;
            nextBtn.onclick = () => switchImage(1);
            bar.appendChild(nextBtn);
        }

        if (settings.enableCounter) {
            counterSpan = document.createElement('span');
            counterSpan.style.cssText = `
                color: white;
                font-size: 13px;
                line-height: 32px;
                margin: 0 6px;
                font-family: monospace;
                text-shadow: 0 1px 2px rgba(0,0,0,0.5);
            `;
            counterSpan.textContent = '0 / 0';
            bar.appendChild(counterSpan);
        }

        if (settings.enableRotateBtn) {
            rotateBtn = document.createElement('button');
            rotateBtn.innerHTML = svgRotate;
            rotateBtn.title = '旋转 (R)';
            rotateBtn.style.cssText = btnStyle;
            rotateBtn.onmouseenter = () => rotateBtn.style.cssText += btnHover;
            rotateBtn.onmouseleave = () => rotateBtn.style.cssText = btnStyle;
            rotateBtn.onclick = () => rotateImage(90);
            bar.appendChild(rotateBtn);
        }

        return bar;
    }

    function renderMedia(item) {
        if (!imgContainer || !item) return;
        mediaElement?.remove();

        mediaElement = document.createElement(item.type === 'video' ? 'video' : 'img');
        mediaElement.src = item.url;
        mediaElement.style.cssText = `
            display: block;
            max-width: 90vw;
            max-height: 90vh;
            width: auto;
            height: auto;
            transition: transform 0.1s ease;
            ${item.type === 'video' ? 'pointer-events: auto;' : 'pointer-events: none;'}
        `;
        if (item.type === 'video') {
            mediaElement.controls = true;
            mediaElement.autoplay = true;
            mediaElement.loop = true;
            mediaElement.playsInline = true;
        }
        mediaElement.onload = () => resetTransform();
        mediaElement.onloadedmetadata = () => resetTransform();
        imgContainer.appendChild(mediaElement);
    }

    function createOverlay(media, mediaList, startIndex) {
        if (overlay) closeOverlay();

        overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.85);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: ${settings.enableDrag ? 'grab' : 'default'};
        `;

        imgContainer = document.createElement('div');
        imgContainer.style.cssText = `
            position: relative;
            display: inline-block;
            cursor: ${settings.enableDrag ? 'grab' : 'default'};
        `;

        overlay.appendChild(imgContainer);
        document.body.appendChild(overlay);

        const controlBar = createControlBar();
        overlay.appendChild(controlBar);

        imageList = mediaList;
        currentIndex = startIndex;
        renderMedia(media);
        if (counterSpan && settings.enableCounter) {
            counterSpan.textContent = `${currentIndex+1} / ${imageList.length}`;
        }

        bindEvents();
    }

    function closeOverlay() {
        if (overlay) {
            const closingOverlay = overlay;
            unbindEvents(closingOverlay);
            closingOverlay.remove();
            overlay = null;
            imgContainer = null;
            mediaElement = null;
            imageList = [];
            currentIndex = -1;
            rotateDeg = 0;
            scale = 1;
            translateX = 0;
            translateY = 0;
            isDragging = false;
        }
    }

    // ======================= 事件绑定 =======================
    function onMouseDown(e) {
        if (!settings.enableDrag) return;
        if (e.target !== overlay && e.target !== imgContainer) return;
        e.preventDefault();
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        lastTranslateX = translateX;
        lastTranslateY = translateY;
        overlay.style.cursor = 'grabbing';
        if (imgContainer) imgContainer.style.cursor = 'grabbing';
    }

    function onMouseMove(e) {
        if (!isDragging) return;
        e.preventDefault();
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        translateX = lastTranslateX + dx;
        translateY = lastTranslateY + dy;
        updateTransform();
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        overlay.style.cursor = 'grab';
        if (imgContainer) imgContainer.style.cursor = 'grab';
    }

    function onWheel(e) {
        if (!settings.enableZoom) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? -1 : 1;
        zoom(delta, e.clientX, e.clientY);
    }

    function onKeyDown(e) {
        if (!overlay) return;
        if (e.key === 'Escape') {
            closeOverlay();
        } else if (settings.enableKeyboard) {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                switchImage(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                switchImage(1);
            } else if (e.key === 'r' || e.key === 'R') {
                e.preventDefault();
                rotateImage(90);
            }
        }
    }

    function bindEvents() {
        overlay.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        overlay.addEventListener('wheel', onWheel, { passive: false });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeOverlay();
        });
        document.addEventListener('keydown', onKeyDown);
    }

    function unbindEvents(targetOverlay) {
        targetOverlay?.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        targetOverlay?.removeEventListener('wheel', onWheel);
        document.removeEventListener('keydown', onKeyDown);
    }

    // ======================= 点击图片监听 =======================
    document.addEventListener('click', function(e) {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
        const clickedMedia = e.target instanceof Element ? e.target.closest('img, video') : null;
        const target = clickedMedia?.tagName === 'VIDEO'
            ? clickedMedia.closest('.GifPlayer')?.querySelector('img')
            : clickedMedia;
        if (!shouldHandleImage(target)) return;

        const media = getMediaInfo(target);
        if (!media) return;
        const mediaList = collectImagesInSameContext(target);
        const startIdx = mediaList.findIndex(item => item.type === media.type && item.url === media.url);

        e.preventDefault();
        e.stopPropagation();
        createOverlay(media, mediaList.length ? mediaList : [media], startIdx === -1 ? 0 : startIdx);
    }, true);

    // ======================= 设置面板 =======================
    function openSettingsPanel() {
        const modal = document.createElement('div');
        modal.id = 'zh-img-settings-modal';
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #2c2c2c;
            color: white;
            padding: 20px;
            border-radius: 12px;
            z-index: 1000001;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            width: 280px;
            font-family: system-ui;
        `;
        modal.innerHTML = `
            <h3 style="margin-top:0">图片增强设置</h3>
            <label><input type="checkbox" id="set_excludeGif" ${settings.excludeGif ? 'checked' : ''}> GIF 保留知乎原生播放</label><br>
            <label><input type="checkbox" id="set_enableZoom" ${settings.enableZoom ? 'checked' : ''}> 启用滚轮缩放</label><br>
            <label><input type="checkbox" id="set_enableDrag" ${settings.enableDrag ? 'checked' : ''}> 启用拖拽移动</label><br>
            <label><input type="checkbox" id="set_enableRotateBtn" ${settings.enableRotateBtn ? 'checked' : ''}> 显示旋转按钮</label><br>
            <label><input type="checkbox" id="set_enablePrevNextBtn" ${settings.enablePrevNextBtn ? 'checked' : ''}> 显示上一张/下一张按钮</label><br>
            <label><input type="checkbox" id="set_enableCounter" ${settings.enableCounter ? 'checked' : ''}> 显示图片计数</label><br>
            <label><input type="checkbox" id="set_enableKeyboard" ${settings.enableKeyboard ? 'checked' : ''}> 启用键盘快捷键</label><br>
            <div style="margin-top: 20px; text-align: right;">
                <button id="saveSettingsBtn" style="margin-right:8px">保存</button>
                <button id="closeSettingsBtn">取消</button>
            </div>
        `;
        document.body.appendChild(modal);

        const saveBtn = modal.querySelector('#saveSettingsBtn');
        const closeBtn = modal.querySelector('#closeSettingsBtn');
        saveBtn.onclick = () => {
            settings.excludeGif = modal.querySelector('#set_excludeGif').checked;
            settings.enableZoom = modal.querySelector('#set_enableZoom').checked;
            settings.enableDrag = modal.querySelector('#set_enableDrag').checked;
            settings.enableRotateBtn = modal.querySelector('#set_enableRotateBtn').checked;
            settings.enablePrevNextBtn = modal.querySelector('#set_enablePrevNextBtn').checked;
            settings.enableCounter = modal.querySelector('#set_enableCounter').checked;
            settings.enableKeyboard = modal.querySelector('#set_enableKeyboard').checked;
            for (let k in settings) {
                saveSetting(k, settings[k]);
            }
            modal.remove();
            alert('设置已保存。刷新页面后生效。');
            location.reload();
        };
        closeBtn.onclick = () => modal.remove();
        modal.addEventListener('click', (e) => e.stopPropagation());
        document.body.addEventListener('click', function closeModal(e) {
            if (e.target === modal) modal.remove();
            document.body.removeEventListener('click', closeModal);
        });
    }
})();
