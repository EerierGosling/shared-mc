'use strict'
const THREE = global.THREE
const { skinUrl } = require('./join')

/**
 * Paints each visitor's chosen skin onto their player entity.
 *
 * prismarine-viewer builds every player from the same default texture and has
 * no notion of per-player skins, so this reaches into the mesh it made and
 * swaps `material.map`. The texture settings mirror what the viewer itself
 * uses when it first loads an entity texture — miss them and the skin comes
 * out smoothed and vertically flipped.
 *
 * Entity ids are only learned from the world stream, and the roster only
 * arrives on join or when someone else joins, so both are kept and the
 * intersection is (re)applied whenever either changes.
 */
class SkinPainter {
  constructor (viewer) {
    this.viewer = viewer
    this.skinByName = new Map() // username -> skin
    this.nameById = new Map() // entity id -> username
    this.applied = new Map() // entity id -> skin already painted
    this.textures = new Map() // skin -> THREE.Texture
    this.loader = new THREE.TextureLoader()
  }

  setRoster (roster) {
    this.skinByName.clear()
    // Real players arrive without a skin; the viewer's default stays on them.
    for (const { username, skin } of roster) if (skin) this.skinByName.set(username, skin)
    this.apply()
  }

  /** Called for every entity message so we learn which id is which player. */
  noteEntity (entity) {
    if (!entity || entity.id === undefined) return
    if (entity.delete) {
      this.nameById.delete(entity.id)
      this.applied.delete(entity.id)
      return
    }
    if (entity.username) this.nameById.set(entity.id, entity.username)
  }

  _texture (skin) {
    let texture = this.textures.get(skin)
    if (texture) return texture
    texture = this.loader.load(skinUrl(skin))
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.flipY = false
    this.textures.set(skin, texture)
    return texture
  }

  apply () {
    const meshes = this.viewer.entities && this.viewer.entities.entities
    if (!meshes) return
    for (const [id, username] of this.nameById) {
      const skin = this.skinByName.get(username)
      if (!skin || this.applied.get(id) === skin) continue
      const mesh = meshes[id]
      if (!mesh) continue // the viewer has not built it yet; retried next tick
      const texture = this._texture(skin)
      let painted = false
      mesh.traverse(child => {
        // The nametag is a Sprite hanging off the same mesh, and SpriteMaterial
        // has a map too; painting it would replace the name with the skin.
        if (child.isSprite) return
        if (!child.material || !('map' in child.material)) return
        child.material.map = texture
        child.material.needsUpdate = true
        painted = true
      })
      if (painted) this.applied.set(id, skin)
    }
  }
}

module.exports = SkinPainter
