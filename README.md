# LocalShare • Local Wi-Fi File Transfer (PC ⇄ iOS)

Local high-speed file transfer web app to send and receive photos, 4K videos, documents, and files between Windows PC and iPhone/iPad over local Wi-Fi without any external cloud or internet limits.

---

## 🚀 Quick Start (In 5 Seconds)

1. **Connect both devices to the same Wi-Fi**:
   - Make sure your PC and iPhone are connected to the same Wi-Fi router (e.g., **`Airtel_DGson`**).
2. **Start the Server on PC**:
   - Double-click **`start_share.bat`** in `E:\` (or run `php -S 0.0.0.0:8080 share_server.php`).
   - Your PC browser will automatically open `http://localhost:8080`.
3. **Open on iPhone**:
   - Open **Safari** on your iPhone and type:
     ```
     http://192.168.1.4:8080
     ```
4. **Done!**
   - Both devices will instantly appear in the **"Connected Devices on Wi-Fi"** list!

---

## 📱 Features

- **No QR Code Needed**: Direct LAN link (`http://192.168.1.4:8080`) with 1-tap copy.
- **Connected Devices Radar**: Whichever devices have the page open are automatically listed in real-time (PC shows iPhone online; iPhone shows PC online).
- **iOS Optimized**:
  - 📸 **"Send Photos & Videos"**: Opens native iOS Photo Library (preserves 4K 60fps MOV/MP4 and HEIC/JPG quality).
  - 📁 **"Send Any File"**: Opens native iOS Files app for PDFs, ZIPs, Docs.
- **PC Drag & Drop**: Drop files directly onto the browser window.
- **Chunked Fast Uploads**: Slices files into 4MB chunks to handle multi-gigabyte video files with 0 memory crash.
- **iOS Safari Video Streaming**: Full HTTP Range support (`206 Partial Content`) for instant video playback and seeking.
- **Shared Folder on PC**: All received files are stored directly in `E:\shared_files\`.
- **Shared Notes / Clipboard**: Copy-paste Wi-Fi passwords, links, or text between PC and iPhone instantly.

---

## 💾 Saving Photos/Videos on iPhone

- When downloading on iPhone:
  - Tap **Preview** on any photo/video.
  - **Photos**: Tap & hold the image, then tap **"Save to Photos"**.
  - **Videos**: Play the video and tap the iOS Share sheet to save directly to Camera Roll.
