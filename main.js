import {
    FilesetResolver,
    HandLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0";

// ponytail: fail loudly if the Three.js CDN was blocked instead of throwing "THREE is not defined" mid-init.
if (typeof THREE === "undefined") {
    document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;inset:auto 12px 12px 12px;z-index:999;padding:12px 16px;background:#3a0d0d;color:#ffd7d7;border:1px solid #a33;border-radius:10px;font-family:sans-serif">Three.js failed to load from CDN. Check your internet connection, then reload over http://localhost (not file://).</div>');
    throw new Error("THREE failed to load from CDN.");
}

// Main entry point
const init = async () => {
    // --- Variables ---
    let handLandmarker = undefined;
    let webcamRunning = false;
    let handResults = undefined;
    const video = document.getElementById("webcam");
    const preview = document.getElementById("preview");
    const camButton = document.getElementById("start-cam");

    // --- Three.js Setup (Initialize IMMEDIATELY so sphere is visible) ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 20;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // Interaction Variables
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2(9999, 9999); // Start off-screen
    const finger = new THREE.Vector2(9999, 9999); // Start off-screen
    const intersectionPoint = new THREE.Vector3();
    const sphereRadius = 10;

    // Global Interaction: Use a large plane instead of a sphere to catch mouse everywhere
    const hitPlaneGeo = new THREE.PlaneGeometry(100, 100);
    const hitPlaneMat = new THREE.MeshBasicMaterial({ visible: false }); // Invisible
    const hitPlane = new THREE.Mesh(hitPlaneGeo, hitPlaneMat);
    hitPlane.position.z = 10; // Move to front of sphere so center isn't deadzone
    scene.add(hitPlane);

    // Particle System
    // Increased segments to 212x212 for ~45,000 particles (11x original)
    const geometry = new THREE.SphereGeometry(sphereRadius, 212, 212);
    const count = geometry.attributes.position.count;
    const originalPositions = new Float32Array(count * 3);
    const positions = geometry.attributes.position.array;

    // Add Color Attribute
    const colors = new Float32Array(count * 3);
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('color', colorAttribute);

    const baseColor = new THREE.Color(0x00ffff);


    for (let i = 0; i < count * 3; i++) {
        originalPositions[i] = positions[i];
    }

    // Initialize colors
    for (let i = 0; i < count; i++) {
        colorAttribute.setXYZ(i, baseColor.r, baseColor.g, baseColor.b);
    }

    geometry.setAttribute('originalPosition', new THREE.BufferAttribute(originalPositions, 3));

    const material = new THREE.PointsMaterial({
        size: 0.1, // Reduced size slightly for density
        vertexColors: true, // Enable per-particle coloring
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending
    });

    const particles = new THREE.Points(geometry, material);
    scene.add(particles);

    // Animation Variables
    const displacementRadius = 4; // Decreased by 2x (was 8)
    const displacementForce = 8; // User requested 8
    const clock = new THREE.Clock();

    // Helper: Determine 3D intersection for a 2D input
    const getIntersection = (inputVector) => {
        raycaster.setFromCamera(inputVector, camera);
        const intersects = raycaster.intersectObject(hitPlane);
        if (intersects.length > 0) {
            const point = intersects[0].point.clone();
            particles.worldToLocal(point);
            return point;
        }
        return null;
    };

    // Animation Loop
    const animate = () => {
        requestAnimationFrame(animate);

        const time = clock.getElapsedTime();

        // Persistent rotation -- STOPPED as requested
        // particles.rotation.y += 0.002;
        // particles.rotation.x += 0.001;

        // --- Process Inputs ---
        let interactors = [];

        // 1. Mouse Input
        if (mouse.x !== 9999) {
            const mousePoint = getIntersection(mouse);
            if (mousePoint) interactors.push(mousePoint);
        }

        // 2. Hand Input
        if (handLandmarker && handResults && handResults.landmarks && handResults.landmarks.length > 0) {
            const landmarks = handResults.landmarks[0];
            const indexTip = landmarks[8]; // Index Finger Tip

            // MediaPipe: x [0 left, 1 right]
            // Flip X for Mirror Effect: Real Left -> Screen Left
            // Standard Mirroring: x = (1 - x)
            // NDC mapping: -1 + (x * 2)
            // Combined: -1 + ((1 - indexTip.x) * 2)

            finger.x = (1 - indexTip.x) * 2 - 1;
            finger.y = -(indexTip.y) * 2 + 1;

            const fingerPoint = getIntersection(finger);
            if (fingerPoint) interactors.push(fingerPoint);
        }

        // --- Particle Update ---
        let targetPos = new THREE.Vector3();
        let originalPos = new THREE.Vector3();
        let normal = new THREE.Vector3();

        const positionAttribute = particles.geometry.attributes.position;
        const originalPositionAttribute = particles.geometry.attributes.originalPosition;

        // Color Animation Variables
        const hue = (time * 0.2) % 1; // Slower, smoother color cycle
        const targetColor = new THREE.Color().setHSL(hue, 0.8, 0.5);
        const tempColor = new THREE.Color();

        for (let i = 0; i < count; i++) {
            originalPos.set(
                originalPositionAttribute.getX(i),
                originalPositionAttribute.getY(i),
                originalPositionAttribute.getZ(i)
            );

            normal.copy(originalPos).normalize();

            // Find closest interaction
            let maxInfluence = 0;

            for (let point of interactors) {
                const dist = originalPos.distanceTo(point);
                if (dist < displacementRadius) {
                    let influence = Math.cos((dist / displacementRadius) * (Math.PI / 2));
                    const noise = Math.sin(time * 3 + dist * 2) * 0.3 + 0.7;
                    influence *= noise;

                    if (influence > maxInfluence) maxInfluence = influence;
                }
            }

            // Position & Color Update
            if (maxInfluence > 0) {
                targetPos.copy(originalPos).addScaledVector(normal, displacementForce * maxInfluence);

                // Color Lerp: Cyan toward Dynamic Target
                tempColor.copy(baseColor).lerp(targetColor, maxInfluence);
                colorAttribute.setXYZ(i, tempColor.r, tempColor.g, tempColor.b);
            } else {
                targetPos.copy(originalPos);
                // Reset to base
                colorAttribute.setXYZ(i, baseColor.r, baseColor.g, baseColor.b);
            }

            // Smooth Position Lerp
            const currentX = positionAttribute.getX(i);
            const currentY = positionAttribute.getY(i);
            const currentZ = positionAttribute.getZ(i);
            const lerpSpeed = 0.1;

            positionAttribute.setXYZ(
                i,
                currentX + (targetPos.x - currentX) * lerpSpeed,
                currentY + (targetPos.y - currentY) * lerpSpeed,
                currentZ + (targetPos.z - currentZ) * lerpSpeed
            );
        }

        positionAttribute.needsUpdate = true;
        colorAttribute.needsUpdate = true;
        renderer.render(scene, camera);
    };

    // Start Loop IMMEDIATELY
    animate();

    // Event Listeners
    window.addEventListener('mousemove', (event) => {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // --- MediaPipe Setup (Async) ---
    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1
        });

        console.log("MediaPipe Loaded");

        // Only enable button if loaded
        if (camButton) {
            camButton.addEventListener("click", () => {
                if (!handLandmarker) return;

                const constraints = { video: true };
                navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
                    video.srcObject = stream;
                    preview.srcObject = stream;
                    video.addEventListener("loadeddata", () => {
                        webcamRunning = true;
                        predictWebcam();
                    });
                    camButton.style.display = 'none';
                }).catch(err => {
                    console.error("Camera access denied or failed", err);
                    alert("Camera access failed. Ensure you are on localhost or HTTPS, not file://");
                });
            });
        }

    } catch (e) {
        console.error("MediaPipe failed to load:", e);
    }

    let lastVideoTime = -1;
    const predictWebcam = async () => {
        if (webcamRunning && handLandmarker) {
            let startTimeMs = performance.now();
            if (lastVideoTime !== video.currentTime) {
                lastVideoTime = video.currentTime;
                handResults = handLandmarker.detectForVideo(video, startTimeMs);
            }
            window.requestAnimationFrame(predictWebcam);
        }
    };
};

init();
